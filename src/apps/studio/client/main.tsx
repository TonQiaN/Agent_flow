import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, date, navigate, type Catalogue, type Workflow } from './api';
import { RunPage, WorkflowCanvas, Badge, Json } from './Run';
import { Upload } from './Upload';
import './style.css';
function App() {
  const [route, setRoute] = useState(
      window.location.hash.slice(1) || '/workflows',
    ),
    [catalogue, setCatalogue] = useState<Catalogue>(),
    [error, setError] = useState(''),
    [upload, setUpload] = useState<Workflow>(),
    [runs, setRuns] = useState<any[]>([]);
  const [refreshCount, setRefreshCount] = useState(0);
  const [workflowFilter, setWorkflowFilter] = useState(''),
    [statusFilter, setStatusFilter] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  useEffect(() => {
    const change = () =>
      setRoute(window.location.hash.slice(1) || '/workflows');
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [route]);
  const refresh = () => {
    setRefreshCount((count) => count + 1);
    api<Catalogue>('workflows')
      .then((v) => {
        setCatalogue(v);
        setError('');
      })
      .catch((e) => setError(e.message));
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (route !== '/history' && route !== '/workflows') return;
    let live = true;
    const params = new URLSearchParams(
      route === '/history'
        ? {
            ...(workflowFilter ? { workflow: workflowFilter } : {}),
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(from
              ? { from: String(new Date(from + 'T00:00:00').getTime()) }
              : {}),
            ...(to
              ? { to: String(new Date(to + 'T23:59:59.999').getTime()) }
              : {}),
          }
        : {},
    );
    api<any>('runs?' + params)
      .then((v) => {
        if (live) setRuns(v.runs);
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [route, workflowFilter, statusFilter, from, to, refreshCount]);
  const selected = route.startsWith('/workflows/')
    ? catalogue?.workflows.find((w) => w.id === route.split('/')[2])
    : undefined;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/workflows">
          <span className="brand-mark">aƒ</span>
          <span>
            AgentFlow<small>LOCAL WORKSPACE</small>
          </span>
        </a>
        <div className="workspace-label">
          <i /> 本机工作台 <span>v1</span>
        </div>
        <nav>
          <a
            className={route.startsWith('/workflows') ? 'active' : ''}
            href="#/workflows"
          >
            <span aria-hidden="true">▦</span>工作流
          </a>
          <a
            className={
              route.startsWith('/runs') || route === '/history' ? 'active' : ''
            }
            href="#/history"
          >
            <span aria-hidden="true">◷</span>运行历史
          </a>
          <a
            className={route === '/settings' ? 'active' : ''}
            href="#/settings"
          >
            <span aria-hidden="true">⚙</span>本机设置
          </a>
        </nav>
        <div className="sidebar-foot">
          <div className="local-pill">
            <i /> LOCAL
          </div>
          <p>
            从一次运行，
            <br />
            看懂每一步。
          </p>
          <small>记录与材料保存在你的电脑</small>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <span>
            工作空间 <b>/</b>{' '}
            {route.startsWith('/runs')
              ? '运行详情'
              : selected
                ? selected.title
                : route === '/history'
                  ? '运行历史'
                  : route === '/settings'
                    ? '本机设置'
                    : '工作流'}
          </span>
          <div>
            <i className="online-dot" />
            {catalogue?.settings.fixture ? '合成测试模式' : '本机运行'}
          </div>
        </div>
        <div className="content">
          {error && (
            <div className="error" role="alert">
              {error}
              <button className="text-button" onClick={refresh}>
                重新连接
              </button>
            </div>
          )}
          {route === '/workflows' && (
            <>
              <header className="page-header">
                <div>
                  <p className="eyebrow">YOUR WORKFLOWS</p>
                  <h1>把流程看清楚</h1>
                  <p>准备材料，开始运行，随时回看每一个步骤。</p>
                </div>
                <div className="catalogue-count">
                  <strong>{catalogue?.workflows.length ?? '—'}</strong>
                  <span>已接入的工作流</span>
                </div>
              </header>
              <div className="intro-strip">
                <span>↗</span>
                <div>
                  <strong>从简历与岗位匹配开始</strong>
                  <p>一个岗位，多份简历。结论有证据，过程可回看。</p>
                </div>
                <button
                  className="secondary"
                  onClick={() => navigate('/workflows/recruitment')}
                >
                  查看流程 →
                </button>
              </div>
              <div className="workflow-grid">
                {catalogue?.workflows.map((w, i) => (
                  <article
                    className={`workflow-card ${w.id === 'recruitment' ? 'featured' : ''}`}
                    key={w.id}
                  >
                    <div className="card-top">
                      <span className="workflow-icon">
                        {w.id === 'recruitment'
                          ? '✦'
                          : w.id.includes('parallel')
                            ? '⋈'
                            : w.id.includes('report')
                              ? '▤'
                              : '◇'}
                      </span>
                      <span className="tag">
                        {w.id === 'recruitment' ? '招聘流程' : '已有流程'}
                      </span>
                      <span className="card-number">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                    </div>
                    <h2>
                      <a href={'#/workflows/' + w.id}>{w.title}</a>
                    </h2>
                    <p>{w.description}</p>
                    <div className="card-bottom">
                      <span
                        className={w.missing.length ? 'setup-needed' : 'ready'}
                      >
                        <i />
                        {w.missing.length ? '需要准备环境' : '可以运行'}
                      </span>
                      <button
                        className="icon-button"
                        aria-label={'查看' + w.title}
                        onClick={() => navigate('/workflows/' + w.id)}
                      >
                        ↗
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <section className="recent">
                <div className="row">
                  <h2>最近的运行</h2>
                  <a href="#/history">全部历史 →</a>
                </div>
                {runs.length ? (
                  <RunTable runs={runs.slice(0, 5)} />
                ) : (
                  <div className="empty-row">
                    这里还没有运行记录。选择一个工作流，开始第一次运行。
                  </div>
                )}
              </section>
            </>
          )}
          {selected && (
            <>
              <header className="page-header">
                <div>
                  <p className="eyebrow">WORKFLOW / {selected.id}</p>
                  <h1>{selected.title}</h1>
                  <p>{selected.description}</p>
                </div>
                <button
                  className="primary"
                  disabled={selected.missing.length > 0}
                  onClick={() => setUpload(selected)}
                >
                  ＋ 发起运行
                </button>
              </header>
              {selected.missing.length > 0 && (
                <div className="notice">
                  <strong>运行前需要：</strong>
                  {selected.missing.join('；')}。
                  <a href="#/settings">查看本机设置</a>
                </div>
              )}
              <div className="flow-note">
                <span>◈ 画布可以拖动与缩放</span>
                <span>◉ 节点和连线支持点击查看</span>
                <span>技术设置只读</span>
              </div>
              <WorkflowCanvas
                definition={selected.definition}
                title={selected.id}
              />
              <section className="panel">
                <h3>这次要准备什么</h3>
                <p>
                  {selected.input === 'recruitment'
                    ? '一份岗位说明、每位候选人的一份简历，以及归属明确的补充材料。全部在同一个弹窗里上传。'
                    : selected.input === 'none'
                      ? '示例自带合成材料，无需上传。'
                      : selected.input === 'grading'
                        ? '原有 source/paper.json、source/key.json、source/submission.json。'
                        : '原 Tutor 工作流的完整 source 材料目录；报告还需要已批改的 candidate 目录和报告信息。'}
                </p>
                <details>
                  <summary>查看流程定义与源码入口</summary>
                  <p className="mono">src/examples/{selected.entrypoint}</p>
                  <Json value={selected.definition} />
                </details>
              </section>
            </>
          )}
          {route.startsWith('/runs/') && (
            <RunPage key={route.split('/')[2]} id={route.split('/')[2]} />
          )}
          {route === '/history' && (
            <>
              <header className="page-header">
                <div>
                  <p className="eyebrow">RUN HISTORY</p>
                  <h1>每一次运行，都能找回来</h1>
                  <p>查看进展、打开结果，或回到当时的某一步。</p>
                </div>
              </header>
              <div className="filters">
                <label>
                  工作流
                  <select
                    value={workflowFilter}
                    onChange={(e) => setWorkflowFilter(e.target.value)}
                  >
                    <option value="">全部工作流</option>
                    {catalogue?.workflows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  状态
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">全部状态</option>
                    {Object.entries({
                      running: '运行中',
                      queued: '排队中',
                      parallel_wait: '等待并行任务',
                      retry_wait: '等待重试',
                      succeeded: '已完成',
                      failed: '执行失败',
                      cancelled: '已取消',
                      exhausted: '次数已用尽',
                      interrupted: '进程已中断',
                      unavailable: '记录不可用',
                    }).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  开始日期
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  结束日期
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                <button
                  className="text-button"
                  onClick={() => {
                    setWorkflowFilter('');
                    setStatusFilter('');
                    setFrom('');
                    setTo('');
                  }}
                >
                  重置
                </button>
              </div>
              <p className="muted">
                共 {runs.length} 条记录 · 保存在本机，不自动清理
              </p>
              {runs.length ? (
                <RunTable runs={runs} />
              ) : (
                <div className="empty-page">
                  <h2>没有符合条件的记录</h2>
                  <p>试试其他筛选条件，或发起一次新运行。</p>
                  <a className="secondary" href="#/workflows">
                    查看工作流
                  </a>
                </div>
              )}
            </>
          )}
          {route === '/settings' && (
            <>
              <header className="page-header">
                <div>
                  <p className="eyebrow">LOCAL SETTINGS</p>
                  <h1>你的本机环境</h1>
                  <p>团队成员各自部署。页面查看设置，修改配置后重启服务。</p>
                </div>
                <button className="secondary" onClick={refresh}>
                  重新检查环境
                </button>
              </header>
              <div className="settings-grid">
                <section className="panel">
                  <span className="section-label">MODEL & RUNTIME</span>
                  <h3>模型与执行器</h3>
                  <dl>
                    <dt>执行器</dt>
                    <dd>{catalogue?.settings.harness}</dd>
                    <dt>模型</dt>
                    <dd>{catalogue?.settings.model}</dd>
                    <dt>凭据</dt>
                    <dd>
                      {catalogue?.settings.credentialConfigured
                        ? '已配置于本机私有存储'
                        : '尚未配置'}
                    </dd>
                    <dt>Agent 镜像</dt>
                    <dd>{catalogue?.settings.image}</dd>
                    <dt>材料镜像</dt>
                    <dd>{catalogue?.settings.documentsImage}</dd>
                    <dt>网络代理镜像</dt>
                    <dd>{catalogue?.settings.proxyImage}</dd>
                  </dl>
                </section>
                <section className="panel">
                  <span className="section-label">DATA & HISTORY</span>
                  <h3>记录与访问</h3>
                  <dl>
                    <dt>数据目录</dt>
                    <dd className="mono">{catalogue?.settings.dataRoot}</dd>
                    <dt>访问范围</dt>
                    <dd>仅这台电脑</dd>
                    <dt>保留时间</dt>
                    <dd>不自动清理</dd>
                    <dt>可用操作</dt>
                    <dd>上传材料、发起运行、查看与回放</dd>
                    <dt>日志范围</dt>
                    <dd>
                      公开事件、工具使用、可获取的 session；隐藏 CoT 不可用。
                    </dd>
                    <dt>Session memory</dt>
                    <dd>隔离任务关闭记忆生成与使用，不读取宿主历史。</dd>
                  </dl>
                </section>
              </div>
              <section className="panel">
                <h3>各工作流的准备情况</h3>
                {catalogue?.workflows.map((w) => (
                  <div className="prereq-row" key={w.id}>
                    <a href={'#/workflows/' + w.id}>{w.title}</a>
                    <span
                      className={w.missing.length ? 'setup-needed' : 'ready'}
                    >
                      {w.missing.join('；') || '可以运行'}
                    </span>
                  </div>
                ))}
                <p className="muted">
                  部署与认证方法见仓库 docs/guides/local-studio.md。API key
                  只存于服务端私有凭据库。
                </p>
              </section>
            </>
          )}
        </div>
        <footer className="page-foot">
          AgentFlow <span>清楚地运行，可靠地回看。</span>
        </footer>
      </main>
      {upload && (
        <Upload
          workflow={upload}
          fixture={!!catalogue?.settings.fixture}
          onClose={() => setUpload(undefined)}
          onStarted={(id) => {
            setUpload(undefined);
            navigate('/runs/' + id);
          }}
        />
      )}
    </div>
  );
}
function RunTable({ runs }: { runs: any[] }) {
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
createRoot(document.getElementById('root')!).render(<App />);
