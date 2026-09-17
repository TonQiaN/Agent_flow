import { useEffect, useRef, useState } from 'react';
import type { Workflow } from './api';
interface Material {
  file: File;
  owner: string;
  kind: string;
  path?: string;
}
function Drop({
  label,
  multiple = false,
  directory = false,
  accept = '.pdf,.docx,.md,.txt,.png,.jpg,.jpeg,.json',
  onFiles,
  files,
}: {
  label: string;
  multiple?: boolean;
  directory?: boolean;
  accept?: string;
  onFiles: (files: File[]) => void;
  files: File[];
}) {
  const input = useRef<HTMLInputElement>(null),
    [over, setOver] = useState(false);
  useEffect(() => {
    if (directory) input.current?.setAttribute('webkitdirectory', '');
  }, [directory]);
  return (
    <div
      className={`drop ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
    >
      <input
        ref={input}
        aria-label={label}
        type="file"
        multiple={multiple || directory}
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
        accept={
          directory ? undefined : accept
        }
      />
      <button
        type="button"
        className="upload-area"
        onClick={() => input.current?.click()}
      >
        <span className="upload-symbol">↥</span>
        <strong>{label}</strong>
        <span>
          {directory ? '点击选择完整材料文件夹' : '拖到这里，或点击选择文件'}
        </span>
      </button>
      {files.length > 0 && (
        <ul className="file-chips">
          {files.map((f, i) => (
            <li key={i}>
              {f.name}
              <small>{Math.ceil(f.size / 1024)} KB</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export function Upload({
  workflow,
  fixture,
  onClose,
  onStarted,
}: {
  workflow: Workflow;
  fixture: boolean;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const [title, setTitle] = useState(workflow.title),
    [job, setJob] = useState(''),
    [notes, setNotes] = useState(''),
    [candidates, setCandidates] = useState<{ id: string; name: string }[]>([
      { id: 'c1', name: '候选人 1' },
    ]);
  const [materials, setMaterials] = useState<Material[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [scenario, setScenario] = useState('normal');
  const [context, setContext] = useState<Record<string, string>>({
    reportId: '',
    title: '',
    studentName: '',
    courseName: '',
    assessmentName: '',
    examYear: String(new Date().getFullYear()),
    authority: '',
    jurisdiction: '',
  });
  const [confirmation, setConfirmation] = useState<{
    file: File;
    value: unknown;
  }>();
  const gradingRequests = useRef<Record<string, number>>({});
  const key = useRef(crypto.randomUUID()),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const add = (files: File[], owner: string, kind: string, single = true) => {
    setError('');
    if (files.some((f) => f.size === 0 || f.size > 20 * 1024 ** 2)) {
      setError('每个文件须为 1 字节至 20 MiB');
      return;
    }
    if (single && files.length !== 1) {
      setError('这里每次只能放一份文件');
      return;
    }
    setMaterials((existing) => [
      ...existing.filter(
        (m) => !single || m.owner !== owner || m.kind !== kind,
      ),
      ...files.map((file) => ({ file, owner, kind })),
    ]);
  };
  const folder = (files: File[]) =>
    setMaterials(
      files.map((file) => {
        const parts = (file.webkitRelativePath || file.name).split('/');
        if (parts[0] !== 'source' && parts[0] !== 'candidate') parts.shift();
        return { file, owner: 'bundle', kind: 'bundle', path: parts.join('/') };
      }),
    );
  const submit = () => {
    setError('');
    if (!title.trim()) {
      setError('请填写运行名称');
      return;
    }
    if (
      workflow.input === 'recruitment' &&
      (!job.trim() ||
        !materials.some((m) => m.kind === 'job') ||
        candidates.some(
          (c) =>
            !c.name.trim() ||
            !materials.some((m) => m.owner === c.id && m.kind === 'resume'),
        ))
    ) {
      setError('请一次备齐岗位说明和每位候选人的简历');
      return;
    }
    if (
      materials.length > 64 ||
      materials.reduce((n, m) => n + m.file.size, 0) > 128 * 1024 ** 2
    ) {
      setError('最多 64 份文件，合计不超过 128 MiB');
      return;
    }
    if (workflow.input === 'grading' && !['paper', 'key', 'submission'].every(name => materials.some(m => m.path === `source/${name}.json`))) {
      setError('请一次备齐三份有效的 JSON 材料'); return;
    }
    const form = new FormData();
    form.set(
      'manifest',
      JSON.stringify({
        workflowId: workflow.id,
        title,
        ...(confirmation ? { completeness: confirmation.value } : {}),
        job: { name: job, notes },
        candidates,
        scenario,
        context: { ...context, examYear: Number(context.examYear) },
        documents: materials.map(({ owner, kind, path }) => ({
          owner,
          kind,
          path,
        })),
      }),
    );
    materials.forEach((m, i) => form.set('file-' + i, m.file));
    setBusy(true);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/runs');
    xhr.setRequestHeader('Idempotency-Key', key.current);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => {
      setError('连接中断，重新点击启动会核对是否已经提交');
      setBusy(false);
    };
    xhr.onload = () => {
      setBusy(false);
      let response;
      try {
        response = JSON.parse(xhr.responseText);
      } catch {
        setError('服务返回了无法读取的结果');
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) onStarted(response.id);
      else setError(response.error ?? '无法启动运行');
    };
    xhr.send(form);
  };
  return (
    <dialog
      className="upload-dialog"
      ref={dialog}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-head">
        <div>
          <p className="eyebrow">START A RUN</p>
          <h2>准备这次运行</h2>
          <p>一次放好所有材料，然后开始。</p>
        </div>
        <button
          aria-label="关闭上传弹窗"
          className="icon-button"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="dialog-content">
        <label>
          运行名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </label>
        {workflow.input === 'recruitment' && (
          <>
            <div className="section-title">
              <span>01</span>
              <h3>一个岗位</h3>
            </div>
            <label>
              岗位名称
              <input
                value={job}
                onChange={(e) => setJob(e.target.value)}
                placeholder="例如：TypeScript 全栈工程师"
                maxLength={200}
              />
            </label>
            <Drop
              label="上传岗位说明"
              files={materials
                .filter((m) => m.kind === 'job')
                .map((m) => m.file)}
              onFiles={(f) => add(f, 'job', 'job')}
            />
            <label>
              补充说明（选填）
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="帮助理解岗位的背景；技术设置请在本机配置。"
              />
            </label>
            <Drop
              multiple
              label="岗位补充材料（选填）"
              files={materials
                .filter((m) => m.owner === 'job' && m.kind === 'supplement')
                .map((m) => m.file)}
              onFiles={(f) => add(f, 'job', 'supplement', false)}
            />
            <div className="section-title">
              <span>02</span>
              <h3>候选人与简历</h3>
              <small>{candidates.length} / 12</small>
            </div>
            {candidates.map((c, i) => (
              <section className="candidate-upload" key={c.id}>
                <div className="row">
                  <label>
                    候选人 {i + 1}
                    <input
                      aria-label={`候选人 ${i + 1} 姓名`}
                      value={c.name}
                      onChange={(e) =>
                        setCandidates((v) =>
                          v.map((p) =>
                            p.id === c.id ? { ...p, name: e.target.value } : p,
                          ),
                        )
                      }
                    />
                  </label>
                  {candidates.length > 1 && i === candidates.length - 1 && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setCandidates((v) => v.slice(0, -1));
                        setMaterials((v) => v.filter((m) => m.owner !== c.id));
                      }}
                    >
                      移除
                    </button>
                  )}
                </div>
                <Drop
                  label={`上传${c.name}的简历`}
                  files={materials
                    .filter((m) => m.owner === c.id && m.kind === 'resume')
                    .map((m) => m.file)}
                  onFiles={(f) => add(f, c.id, 'resume')}
                />
                <Drop
                  multiple
                  label={`${c.name}的补充材料（选填）`}
                  files={materials
                    .filter((m) => m.owner === c.id && m.kind === 'supplement')
                    .map((m) => m.file)}
                  onFiles={(f) => add(f, c.id, 'supplement', false)}
                />
              </section>
            ))}
            <button
              className="secondary full"
              disabled={candidates.length >= 12}
              onClick={() =>
                setCandidates((v) => [
                  ...v,
                  { id: `c${v.length + 1}`, name: `候选人 ${v.length + 1}` },
                ])
              }
            >
              ＋ 添加候选人
            </button>
            <p className="muted">
              PDF、DOCX、TXT、MD、PNG、JPEG；每份 20 MiB，总计 128 MiB。
            </p>
          </>
        )}
        {workflow.input === 'grading' && (
          <>
            <p>一次选择三份原有 JSON 材料。</p>
            {['paper', 'key', 'submission'].map((name) => (
              <Drop
                key={name}
                label={`上传 ${name}.json`}
                accept=".json"
                files={materials
                  .filter((m) => m.path === `source/${name}.json`)
                  .map((m) => m.file)}
                onFiles={async (files) => {
                  const request = (gradingRequests.current[name] ?? 0) + 1;
                  gradingRequests.current[name] = request;
                  setMaterials(v => v.filter(m => m.path !== `source/${name}.json`));
                  const file = files[0];
                  if (files.length !== 1 || !file?.name.toLowerCase().endsWith('.json')) return setError('请选择一份 .json 文件');
                  if (!file.size || file.size > 20 * 1024 ** 2) return setError('每个文件须为 1 字节至 20 MiB');
                  try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
                  catch { if (gradingRequests.current[name] === request) setError('文件不是有效的 JSON'); return; }
                  if (gradingRequests.current[name] !== request) return;
                  setError('');
                  setMaterials((v) => [
                    ...v.filter((m) => m.path !== `source/${name}.json`),
                    {
                      file: files[0],
                      owner: 'bundle',
                      kind: 'bundle',
                      path: `source/${name}.json`,
                    },
                  ]);
                }}
              />
            ))}
          </>
        )}
        {workflow.input.startsWith('tutor-') && (
          <>
            <p>
              选择包含 source/{' '}
              {workflow.input === 'tutor-report' ? '和 candidate/' : ''}{' '}
              的完整材料文件夹，目录关系会保留。
            </p>
            <Drop
              directory
              multiple
              label="选择完整材料文件夹"
              files={materials.map((m) => m.file)}
              onFiles={folder}
            />
            {workflow.input === 'tutor-report' && (
              <div className="form-grid">
                {Object.keys(context).map((k) => (
                  <label key={k}>
                    {
                      (
                        {
                          reportId: '报告 ID',
                          title: '报告标题',
                          studentName: '学生姓名',
                          courseName: '课程',
                          assessmentName: '考试名称',
                          examYear: '考试年份',
                          authority: '考试机构',
                          jurisdiction: '地区',
                        } as any
                      )[k]
                    }
                    <input
                      value={context[k]}
                      onChange={(e) =>
                        setContext((v) => ({ ...v, [k]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </>
        )}
        {workflow.input === 'tutor-report' && (
          <>
            <Drop
              label="上传材料完整性确认 JSON（选填）"
              files={confirmation ? [confirmation.file] : []}
              onFiles={async (files) => {
                try {
                  if (files.length !== 1 || files[0].size > 65536)
                    throw new Error('请上传一份小于 64 KiB 的确认 JSON');
                  const value = JSON.parse(await files[0].text());
                  if (
                    value.schema_version !== 1 ||
                    value.submission_complete !== true ||
                    !/^[a-f0-9]{64}$/.test(value.candidate_sha256) ||
                    !value.confirmation_text ||
                    !value.confirmed_at ||
                    !value.job_id ||
                    !Array.isArray(value.missing_item_ids)
                  )
                    throw new Error(
                      '完整性确认格式无效，请使用已绑定候选材料的原确认对象',
                    );
                  setConfirmation({ file: files[0], value });
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
            <p className="muted">
              只使用你已有的完整性确认。未上传时保留未确认状态。
            </p>
          </>
        )}
        {workflow.input === 'none' && (
          <div className="notice">
            这个示例已带齐合成材料，点击启动即可运行原有工作流。
          </div>
        )}
        {fixture && workflow.id === 'recruitment' && (
          <label>
            合成测试场景
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              {Object.entries({
                normal: '正常完成',
                rework: '候选人证据返工',
                'job-rework': '岗位证据返工',
                retry: '执行失败后重试',
                failure: '最终执行失败',
                exhausted: '证据始终错误，耗尽返工',
                cancel: '队列取消',
              }).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        {materials.some((m) => m.kind === 'supplement') && (
          <div>
            <h4>补充材料清单</h4>
            {materials.map(
              (m, i) =>
                m.kind === 'supplement' && (
                  <div className="row" key={i}>
                    <span>
                      {m.owner === 'job'
                        ? '岗位'
                        : candidates.find((c) => c.id === m.owner)?.name}{' '}
                      · {m.file.name}
                    </span>
                    <button
                      className="text-button"
                      onClick={() =>
                        setMaterials((v) => v.filter((_m, j) => j !== i))
                      }
                    >
                      移除
                    </button>
                  </div>
                ),
            )}
          </div>
        )}
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
      </div>
      <footer className="dialog-footer">
        <span>
          {busy
            ? `上传 ${progress}% · ${progress === 100 ? '正在校验材料' : '请稍候'}`
            : `已选择 ${materials.length} 份材料`}
        </span>
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? '正在准备…' : '确认材料，开始运行 →'}
        </button>
      </footer>
    </dialog>
  );
}
