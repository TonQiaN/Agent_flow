import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, FileContractRegistry, compileWorkflow, WorkflowRuntime, snapshotJson } from '@agentflow/engine';
import { SqliteRunRecordStore, createWorkflowRecorder, FileArtifactArchive } from '@agentflow/integrations';

function pdf() {
  const content = (text: string) => `BT /F1 24 Tf 40 180 Td (${text}) Tj ET`;
  const a = content('Build report: Python output'), b = content('Verification complete - page two');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 250] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>', `<< /Length ${a.length} >>\nstream\n${a}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 250] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>', `<< /Length ${b.length} >>\nstream\n${b}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 8\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return result + `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
/** Actual host Workflow plus immutable artifacts, only in an isolated test data root. */
export async function seedArtifactRun(dataRoot: string) {
  const id = 'run-code-' + randomUUID(), root = join(dataRoot, 'runs', id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const records = await SqliteRunRecordStore.open(join(root, 'records'));
  const contracts = new ContractRegistry(); contracts.register('data', true);
  const components = new ComponentRegistry(contracts), functions = new FunctionRegistry();
  for (const node of ['build', 'verify']) {
    components.register({ id: node, implementation: node, kind: 'transform', inputContract: 'data', outcomes: { completed: 'data' } });
    functions.registerDeterministic(node, { revision: 'fixture-v1', run: () => ({ outcome: 'completed', output: { language: 'Python', recommendations: ['Use a virtual environment'], checked: node === 'verify', files: ['analysis.py', 'build.pdf'] } }) });
  }
  const compiled = compileWorkflow({ id: 'code-generation', start: 'build', input: { kind: 'json', id: 'data' }, outcomes: { published: { kind: 'json', id: 'data' } }, maxSteps: 2,
    nodes: { build: { component: 'build' }, verify: { component: 'verify' } }, routes: [{ from: 'build', outcome: 'completed', to: { node: 'verify' } }, { from: 'verify', outcome: 'completed', to: { end: 'published' } }] }, new JsonFunctionWorkflowCatalog(contracts, components, functions));
  const createdAt = Date.now();
  await writeFile(join(root, 'meta.json'), JSON.stringify({ id, mainRunId: id, workflowId: 'code-generation', title: '代码与自定义 PDF · 验收', createdAt, uploads: [], fixture: true }));
  const archiveContracts = new FileContractRegistry(contracts), archive = new FileArtifactArchive(join(root, 'archive'), archiveContracts);
  const observer = await createWorkflowRecorder(records, compiled, { title: '代码产物测试', entrypoint: 'browser-fixture' });
  try {
    const result = await new WorkflowRuntime(undefined, observer).start(compiled, id, { task: 'generate code' }).completion;
    for (const [index, step] of result.steps.entries()) {
      const source = join(root, `generated-${index}`); await mkdir(source);
      const content: Record<string, string> = index === 0 ? { 'analysis.py': 'def normalize(values):\n    """Generated code; preview must never execute it."""\n    return [str(v).strip() for v in values]\n', 'result.json': '{"stage":"build"}', 'empty.log': '' }
        : { 'build.pdf': pdf(), 'result.json': '{"stage":"verify","passed":true}', 'large.txt': 'Saved output line.\n'.repeat(20000), 'payload.bin': '\u0000\u0001\u0002', 'page.html': '<script>document.title="EXECUTED"</script><h1>Output source only</h1>' };
      for (const [name, value] of Object.entries(content)) await writeFile(join(source, name), value);
      archiveContracts.register(`files-${index}`, { rules: [{ id: 'files', kind: 'file', match: '*', minCount: 1, maxCount: 10, maxBytes: 1024 * 1024, mediaTypes: ['text/plain', 'text/html', 'application/octet-stream', 'application/json', 'application/pdf'] }], maxFiles: 10, maxTotalBytes: 1024 * 1024, unmatched: 'reject' });
      const saved = await archive.capture(source, `files-${index}`);
      await records.appendEvent(id, snapshotJson({ kind: 'artifact', identity: step.result.identity, accepted: true, saved: { schema: 'agentflow-workflow-files/v1', archive: saved.reference } }));
    }
    await writeFile(join(root, 'completion.json'), JSON.stringify({ finishedAt: Date.now(), error: null }));
    return { id, root };
  } finally { records.close(); }
}
