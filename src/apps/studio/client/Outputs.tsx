import { pretty, type Artifact } from './api';
import { fileOwner, previewKind } from './presentation';
import { nameOf } from './graph-model';
export function OutputValue({ value }: { value: unknown }) {
  if (value === undefined) return <p className="muted">暂无输出。</p>;
  if (value === null || typeof value !== 'object') return <pre className="text-preview">{typeof value === 'string' ? value : pretty(value)}</pre>;
  if (Array.isArray(value)) {
    const flat = value.length && value.every(v => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => x === null || typeof x !== 'object'));
    const keys = flat ? [...new Set(value.flatMap(v => Object.keys(v)))] : [];
    if (flat && keys.length <= 8) return <div className="table-wrap"><table><thead><tr>{keys.map(k => <th key={k}>{k}</th>)}</tr></thead>
      <tbody>{value.slice(0, 100).map((v, i) => <tr key={i}>{keys.map(k => <td key={k}>{typeof v[k] === 'string' ? v[k] : pretty(v[k])}</td>)}</tr>)}</tbody></table>
      {value.length > 100 && <p className="muted">预览前 100 行；完整内容见原始输出。</p>}</div>;
    return <pre className="json">{pretty(value)}</pre>;
  }
  return <dl className="output-values">{Object.entries(value).map(([key, v]) => <div key={key}><dt>{key}</dt><dd>
    {v !== null && typeof v === 'object' ? <details><summary>{Array.isArray(v) ? `${v.length} 项` : `${Object.keys(v).length} 个字段`}</summary><pre className="json">{pretty(v)}</pre></details>
      : typeof v === 'string' ? v : pretty(v)}</dd></div>)}</dl>;
}
export function ArtifactCards({ files, onOpen }: { files: Artifact[]; onOpen: (f: Artifact) => void }) {
  if (!files.length) return null;
  return <section className="result-artifacts"><h3>产物文件 <small>{files.length}</small></h3><div className="artifact-cards">{files.map(f => <button key={f.id} onClick={() => onOpen(f)}>
    <span className="file-format">{previewKind(f).toUpperCase()}</span><strong>{f.name}</strong><small>{fileOwner(f)?.node ? nameOf(fileOwner(f)!.node!) + ' · ' : ''}{f.unavailable ? '归档不可用' : `${Math.ceil(f.bytes / 1024)} KB`}</small><b>查看 ↗</b>
  </button>)}</div></section>;
}
