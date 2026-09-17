import { useEffect, useState } from 'react';
import { api, date, type Workflow } from './api';
import { Badge, Json, WorkflowCanvas } from './Run';
import { flowOrder, primaryPath, nameOf } from './graph-model';

const familyNames: Record<string, string> = {
  recruitment: '招聘',
  grading: '试卷批改',
  report: '学习报告',
  examples: '技术示例',
};
export function WorkflowLibrary({
  workflows,
  runs,
  loading,
}: {
  workflows: Workflow[];
  runs: any[];
  loading: boolean;
}) {
  const [scope, setScope] = useState('business'),
    [search, setSearch] = useState('');
  const filtered = workflows.filter(
    (w) =>
      (w.category ?? (w.input === 'none' ? 'example' : 'business')) === scope &&
      (w.title + w.id).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="workflow-library">
      <header className="library-header">
        <div>
          <h1>工作流</h1>
          <span>
            {loading
              ? '正在读取…'
              : workflows.filter((w) => w.category === 'business').length +
                ' 个业务工作流'}
          </span>
        </div>
        <input
          aria-label="搜索工作流"
          placeholder="搜索名称或 ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>
      <div className="library-switch">
        <button
          className={scope === 'business' ? 'active' : ''}
          onClick={() => setScope('business')}
        >
          业务工作流
        </button>
        <button
          className={scope === 'example' ? 'active' : ''}
          onClick={() => setScope('example')}
        >
          技术示例
        </button>
      </div>
      <div className="workflow-list">
        {filtered.map((w) => {
          const order = flowOrder(w.definition),
            path = primaryPath(w.definition),
            recent = runs.find((r) => r.workflowId === w.id);
          const preview =
            path.length > 5 ? [...path.slice(0, 3), '…', path.at(-1)!] : path;
          return (
            <article className="workflow-entry" key={w.id} data-workflow={w.id}>
              <div className="workflow-entry-main">
                <span
                  className={`workflow-emblem ${w.family}`}
                  aria-hidden="true"
                >
                  {w.family === 'recruitment'
                    ? '⑂'
                    : w.family === 'report'
                      ? '▤'
                      : '▦'}
                </span>
                <div>
                  <div className="workflow-heading">
                    <h2>
                      <a href={'#/workflows/' + w.id}>{w.title}</a>
                    </h2>
                    <span className="workflow-family">
                      {familyNames[w.family] ?? '工作流'}
                    </span>
                  </div>
                  <div className="workflow-meta">
                    <code>{w.id}</code>
                    <span>{order.length} 个节点</span>
                    <span
                      className={w.missing.length ? 'setup-needed' : 'ready'}
                    >
                      {w.missing.length ? '待配置' : '就绪'}
                    </span>
                  </div>
                </div>
                <a
                  className="open-workflow"
                  aria-label={'打开工作流 ' + w.title}
                  href={'#/workflows/' + w.id}
                >
                  打开画布 ↗
                </a>
              </div>
              <a
                className="flow-preview"
                href={'#/workflows/' + w.id}
                aria-label={w.title + '的节点预览'}
              >
                {preview.map((node, i) => (
                  <span key={node}>
                    <b>{node === '…' ? '…' : nameOf(node)}</b>
                    {i < preview.length - 1 && <i>→</i>}
                  </span>
                ))}
              </a>
              <div className="workflow-entry-foot">
                <span>{w.description}</span>
                {recent ? (
                  <a href={'#/runs/' + recent.id}>
                    <Badge status={recent.status} />
                    查看最近运行 →
                  </a>
                ) : (
                  <small>尚无运行记录</small>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {loading ? (
        <div className="catalogue-loading" role="status">
          正在读取工作流…
        </div>
      ) : (
        !filtered.length && (
          <div className="empty-page">
            <h2>没有匹配的工作流</h2>
          </div>
        )
      )}
      {runs.length > 0 && (
        <section className="recent">
          <div className="row">
            <h2>最近运行</h2>
            <a href="#/history">全部历史 →</a>
          </div>
          <RunTable runs={runs.slice(0, 5)} />
        </section>
      )}
    </div>
  );
}
export function WorkflowPage({
  workflow,
  onRun,
}: {
  workflow: Workflow;
  onRun: () => void;
}) {
  const [tab, setTab] = useState('canvas'),
    [runs, setRuns] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () =>
      api<any>('runs?' + new URLSearchParams({ workflow: workflow.id }))
        .then((v) => {
          if (live) {
            setRuns(v.runs);
            setError('');
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workflow.id]);
  const latest =
    runs.find((r) => r.status === 'succeeded' && r.outcome !== 'rejected') ??
    runs[0];
  return (
    <section
      className={
        'workflow-workspace ' + (tab === 'canvas' ? 'canvas-active' : '')
      }
    >
      <header className="workspace-header page-header">
        <a
          className="back-workflows"
          href="#/workflows"
          aria-label="返回工作流"
        >
          ←
        </a>
        <div className="workspace-title">
          <h1>{workflow.title}</h1>
          <span>
            <code>{workflow.id}</code> ·{' '}
            {Object.keys(workflow.definition.nodes).length} 个节点
          </span>
        </div>
        <nav className="workspace-tabs">
          <button
            className={tab === 'canvas' ? 'active' : ''}
            onClick={() => setTab('canvas')}
          >
            流程定义
          </button>
          <button
            className={tab === 'runs' ? 'active' : ''}
            onClick={() => setTab('runs')}
          >
            运行记录 <span>{runs.length}</span>
          </button>
          <button
            className={tab === 'config' ? 'active' : ''}
            onClick={() => setTab('config')}
          >
            配置
          </button>
        </nav>
        <button
          className="primary launch-button"
          disabled={workflow.missing.length > 0}
          onClick={onRun}
        >
          ＋ 发起运行
        </button>
      </header>
      {workflow.missing.length > 0 && (
        <div className="notice compact-notice">
          {workflow.missing.join('；')} <a href="#/settings">准备环境 →</a>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {tab === 'canvas' && (
        <>
          {latest && (
            <a className="latest-run-strip" href={'#/runs/' + latest.id}>
              <Badge status={latest.status} />
              <span>
                {latest.status === 'succeeded' ? '最近完成' : '最近运行'}
                <b>{latest.title}</b>
              </span>
              <time>{date(latest.createdAt)}</time>
              <strong>查看完整运行 →</strong>
            </a>
          )}
          <WorkflowCanvas
            workflow={workflow}
          />
        </>
      )}
      {tab === 'runs' && (
        <div className="workspace-content">
          <h2>此工作流的运行</h2>
          {runs.length ? (
            <RunTable runs={runs} />
          ) : (
            <div className="empty-page">
              <h3>还没有运行记录</h3>
              <button
                className="primary"
                disabled={!!workflow.missing.length}
                onClick={onRun}
              >
                ＋ 发起运行
              </button>
            </div>
          )}
        </div>
      )}
      {tab === 'config' && (
        <div className="workspace-content">
          <section className="panel">
            <h2>流程配置</h2>
            <dl>
              <dt>Workflow ID</dt>
              <dd>{workflow.id}</dd>
              <dt>源码入口</dt>
              <dd>src/examples/{workflow.entrypoint}</dd>
              <dt>运行材料</dt>
              <dd>
                {workflow.input === 'recruitment'
                  ? '一个岗位说明、多份简历及归属明确的补充材料'
                  : workflow.input === 'none'
                    ? '示例自带合成材料'
                    : workflow.input === 'grading'
                      ? '试卷、答案与提交 JSON'
                      : '完整 Tutor 材料目录'}
              </dd>
            </dl>
            <details>
              <summary>完整流程定义</summary>
              <Json value={workflow.definition} />
            </details>
          </section>
        </div>
      )}
    </section>
  );
}
export function RunTable({ runs }: { runs: any[] }) {
  return (
    <div className="table-wrap run-table">
      <table>
        <thead>
          <tr>
            <th>运行</th>
            <th>状态</th>
            <th>开始时间</th>
            <th>来源</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <a href={'#/runs/' + r.id}>
                  <strong>{r.title}</strong>
                  <small>
                    {r.workflowId ?? '未知工作流'} · {r.id.slice(-8)}
                  </small>
                </a>
              </td>
              <td>
                <Badge status={r.status} />
                {r.outcome === 'rejected' && <small>业务校验未通过</small>}
              </td>
              <td>{date(r.createdAt)}</td>
              <td>
                {r.fixture
                  ? '合成测试'
                  : r.source === 'cli'
                    ? 'CLI'
                    : '页面启动'}
              </td>
              <td>
                <a aria-label={'查看运行 ' + r.title} href={'#/runs/' + r.id}>
                  查看 →
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
