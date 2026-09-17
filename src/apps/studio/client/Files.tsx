import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { pretty, type Artifact, type RunDetail } from './api';
import { fileGroup, fileOwner, previewKind, timestamp } from './presentation';
import { nameOf } from './graph-model';
const PdfPreview = lazy(() => import('./PdfPreview'));
export function Files({ id, files, runs, selected, onSelect, onNode }: {
  id: string; files: Artifact[]; runs: RunDetail['runs']; selected?: Artifact;
  onSelect: (file: Artifact) => void;
  onNode: (runId: string, node: string, nodeTaskId?: string) => void;
}) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all');
  const [text, setText] = useState(''), [error, setError] = useState(''), [truncated, setTruncated] = useState(false);
  const [copyStatus, setCopyStatus] = useState(''), [loading, setLoading] = useState(false);
  const kind = selected ? previewKind(selected) : null;
  useEffect(() => {
    setCopyStatus(''); setText(''); setError(''); setTruncated(false); setLoading(false);
    if (!selected || selected.unavailable || !['text', 'code', 'json'].includes(kind!)) return;
    setLoading(true);
    const controller = new AbortController();
    fetch(`/api/runs/${id}/file/${selected.id}?preview=1`, { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error((await r.json()).error ?? '文件无法读取');
      const body = await r.text();
      if (controller.signal.aborted) return;
      setTruncated(r.headers.get('x-preview-truncated') === '1');
      if (kind === 'json') { try { setText(pretty(JSON.parse(body))); return; } catch { /* Raw truncated or invalid JSON remains readable. */ } }
      setText(body);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, selected?.id, kind]);
  const groups = useMemo(() => {
    const groups = new Map<string, { title: string; owner: ReturnType<typeof fileGroup>; files: Artifact[] }>();
    for (const f of files) {
      const owner = fileGroup(f, runs), role = !f.accepted ? 'draft' : owner.role;
      if (filter !== 'all' && filter !== role || search && !`${f.name} ${owner.node ? nameOf(owner.node) : ''}`.toLowerCase().includes(search.toLowerCase())) continue;
      const title = owner.key === 'input' ? '原始输入' : owner.node ? nameOf(owner.node) : '来源未记录';
      if (!groups.has(owner.key)) groups.set(owner.key, { title, owner, files: [] });
      groups.get(owner.key)!.files.push(f);
    }
    return [...groups.values()];
  }, [files, runs, filter, search]);
  const owner = selected ? fileGroup(selected, runs) : null;
  return <section className="files-layout">
    <aside className="panel file-list">
      <h3>文件 <small>{files.length}</small></h3>
      <input aria-label="搜索文件或节点" placeholder="搜索文件或节点" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="文件类型范围" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">全部文件</option><option value="output">节点输出</option><option value="input">原始输入</option><option value="draft">失败草稿</option>
      </select>
      {!groups.length && <p className="muted">没有匹配的文件。</p>}
      {groups.map(group => <details className="file-group" key={group.owner.key} open>
        <summary><strong>{group.title}</strong><span>{group.files.length}</span>
          {group.owner.nodeTaskId && <small>{group.owner.nodeTaskId} · 尝试 {group.owner.attemptNumber ?? '未记录'}</small>}
          {runs.length > 1 && group.owner.node && <small>{runs.find(r => r.view.runId === group.owner.runId)?.view.snapshot.workflowId ?? group.owner.runId}</small>}
        </summary>
        {group.files.map(f => <button className={`file-row ${selected?.id === f.id ? 'active' : ''}`} key={f.id} onClick={() => onSelect(f)}>
          <strong>{f.name}</strong><small>{previewKind(f).toUpperCase()} · {Math.ceil(f.bytes / 1024)} KB</small>
          {(!f.accepted || f.unavailable) && <span className="draft">{f.unavailable ? '归档不可用' : '未接纳的草稿'}</span>}
        </button>)}
      </details>)}
    </aside>
    <section className="panel preview">
      {selected ? <>
        <div className="row preview-header"><div><h3>{selected.name}</h3><span className="file-format">{kind === 'code' ? '源码' : kind?.toUpperCase()}</span></div>
          <a className="secondary" href={`/api/runs/${id}/file/${selected.id}?download=1`}>下载文件 ↓</a></div>
        {owner?.node && <button className="text-button file-origin" onClick={() => onNode(owner.runId, owner.node!, owner.nodeTaskId)}>
          {nameOf(owner.node)} · {owner.nodeTaskId ?? '节点'} · 尝试 {owner.attemptNumber ?? '未记录'} ↗
        </button>}
        <details className="file-metadata"><summary>文件信息</summary><p>保存时间 · {timestamp(fileOwner(selected)?.recordedAt)}</p><p className="mono">SHA256 {selected.sha256 || '未记录'}</p>
          {(selected.sources?.length ?? 0) > 1 && <pre className="json">{pretty(selected.sources)}</pre>}</details>
        {selected.unavailable || error ? <div className="error" role="alert">{selected.unavailable ?? error}</div>
          : kind === 'pdf' ? <Suspense fallback={<p>正在读取 PDF…</p>}><PdfPreview key={selected.id} name={selected.name} url={`/api/runs/${id}/file/${selected.id}`} /></Suspense>
            : kind === 'image' ? <img alt={selected.name} src={`/api/runs/${id}/file/${selected.id}`} />
              : kind === 'binary' ? <p className="muted">此格式可下载到本机查看。</p>
                : <><div className="preview-tools"><span>{kind === 'code' ? '只读源码' : kind === 'json' ? 'JSON' : '文本'}</span>
                  <button className="text-button" disabled={loading} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopyStatus('已复制'); } catch { setCopyStatus('请选中文字复制'); } }}>{copyStatus || '复制内容'}</button></div>
                  <pre className={`text-preview ${kind === 'code' ? 'code-preview' : ''}`}>{loading ? '正在读取…' : text || '空文件'}</pre>
                  {truncated && <p className="notice">预览前 256 KiB，下载可查看完整文件。</p>}</>}
      </> : <div className="empty-page"><h3>选择文件</h3><p>按节点查看输入、输出和草稿。</p></div>}
    </section>
  </section>;
}
