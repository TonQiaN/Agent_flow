import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hash } from './data.js';
import { isArtifactPath } from '@agentflow/engine';
const extensions = new Set(['pdf', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg']);
const text = (v: unknown, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export async function prepareUpload(form: FormData, root: string, workflow: { id: string; input: string }, fixture: boolean) {
  const raw = form.get('manifest'); if (typeof raw !== 'string' || raw.length > 65536) throw new Error('上传信息无效');
  const manifest = JSON.parse(raw); if (manifest.workflowId !== workflow.id || !text(manifest.title)) throw new Error('请填写运行名称');
  const documents = manifest.documents ?? []; if (!Array.isArray(documents) || documents.length > 64 || [...form.keys()].length !== documents.length + 1) throw new Error('文件数量或上传信息不一致');
  const checked: { path: string; bytes: Buffer; name: string; mediaType: string; sha256: string }[] = [], used = new Set<string>();
  let total = 0;
  for (const [i, document] of documents.entries()) {
    const file = form.get(`file-${i}`); if (!(file instanceof File) || !file.size || file.size > 20 * 1024 ** 2 || !text(file.name, 255)) throw new Error('每个文件须为 1 字节至 20 MiB');
    total += file.size; if (total > 128 * 1024 ** 2) throw new Error('所有文件合计不能超过 128 MiB');
    const extension = file.name.split('.').at(-1)!.toLowerCase();
    let path: string;
    if (workflow.input === 'recruitment') {
      if (!extensions.has(extension)) throw new Error('招聘材料支持 PDF、DOCX、TXT、MD、PNG、JPG');
      path = `document-${i}.${extension}`;
    } else {
      path = document.path ?? file.name; if (!isArtifactPath(path) || !/^(source|candidate)\//.test(path) || !/\.(json|pdf|png|jpe?g|webp|txt|md|heic|heif)$/i.test(path)) throw new Error('请按 source/、candidate/ 目录上传对应材料');
    }
    if (used.has(path)) throw new Error('存在重复文件路径'); used.add(path);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (extension === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || extension === 'png' && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || ['jpg', 'jpeg'].includes(extension) && bytes.subarray(0, 2).toString('hex') !== 'ffd8' || extension === 'docx' && bytes.subarray(0, 2).toString() !== 'PK') throw new Error('文件内容与扩展名不一致');
    if (['json', 'md', 'txt'].includes(extension)) { try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (extension === 'json') JSON.parse(value); } catch { throw new Error('文本编码或 JSON 内容无效'); } }
    const mediaType = ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json', md: 'text/markdown', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as Record<string, string>)[extension] ?? 'application/octet-stream';
    checked.push({ path, bytes, name: file.name, mediaType, sha256: hash(bytes) });
  }
  let input: any = {};
  if (workflow.input === 'recruitment') {
    if (!text(manifest.job?.name) || !Array.isArray(manifest.candidates) || !manifest.candidates.length || manifest.candidates.length > 12 || !manifest.candidates.every((c: any, i: number) => c.id === `c${i + 1}` && text(c.name))) throw new Error('请填写一个岗位和 1 至 12 位候选人');
    const candidates = manifest.candidates.map((c: any) => ({ id: c.id, name: c.name }));
    const mapped = documents.map((d: any, i: number) => ({ id: `d${i + 1}`, owner: d.owner, kind: d.kind, name: checked[i]!.name, storedName: checked[i]!.path }));
    if (mapped.filter((d: any) => d.owner === 'job' && d.kind === 'job').length !== 1) throw new Error('请上传且只上传一份岗位说明');
    for (const person of candidates) if (mapped.filter((d: any) => d.owner === person.id && d.kind === 'resume').length !== 1) throw new Error(`${person.name} 需要一份简历`);
    if (mapped.some((d: any) => !['job', ...candidates.map((c: any) => c.id)].includes(d.owner) || !['job', 'resume', 'supplement'].includes(d.kind) || d.kind === 'job' && d.owner !== 'job' || d.kind === 'resume' && d.owner === 'job')) throw new Error('文件归属不正确');
    input = { job: { name: manifest.job.name, notes: typeof manifest.job.notes === 'string' ? manifest.job.notes.slice(0, 10000) : '' }, candidates, documents: mapped, ...(fixture ? { scenario: ['normal', 'rework', 'job-rework', 'retry', 'failure', 'cancel'].includes(manifest.scenario) ? manifest.scenario : 'normal' } : {}) };
  } else if (workflow.input === 'grading') {
    if (['source/paper.json', 'source/key.json', 'source/submission.json'].some(p => !used.has(p)) || checked.length !== 3) throw new Error('请一次上传 source/paper.json、key.json、submission.json');
  } else if (workflow.input.startsWith('tutor-')) {
    if (!used.has('source/input/marking-input.json') && workflow.input === 'tutor-marking') throw new Error('缺少 source/input/marking-input.json');
    if (workflow.input === 'tutor-report') {
      if (['assessment-reference', 'submission-mapping', 'marking-candidate'].some(n => !used.has(`candidate/${n}.json`))) throw new Error('缺少已批改的三份 candidate JSON');
      const context = manifest.context; if (!context || !['reportId', 'title', 'studentName', 'courseName', 'assessmentName', 'authority', 'jurisdiction'].every(k => text(context[k])) || !Number.isInteger(context.examYear)) throw new Error('请填写完整的报告信息');
      input = { context, ...(manifest.completeness ? { completeness: manifest.completeness } : {}) };
    }
  } else if (checked.length) throw new Error('这个示例不需要上传文件');
  await mkdir(join(root, 'uploads'), { mode: 0o700 });
  for (const file of checked) { const path = join(root, 'uploads', file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 }); }
  await writeFile(join(root, 'input.json'), JSON.stringify({ workflowId: workflow.id, input }), { mode: 0o600 });
  return { title: manifest.title, uploads: checked.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length })), input };
}
