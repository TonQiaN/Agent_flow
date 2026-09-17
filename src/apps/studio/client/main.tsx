import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, navigate, type Catalogue, type Workflow } from './api';
import { RunPage } from './Run';
import { WorkflowLibrary, WorkflowPage, RunTable } from './Workspace';
import { Upload } from './Upload';
import './style.css';
import './workspace.css';
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
        <div
          className={
            'content' +
            (selected || route.startsWith('/runs/')
              ? ' workspace-content-shell'
              : '')
          }
        >
          {error && (
            <div className="error" role="alert">
              {error}
              <button className="text-button" onClick={refresh}>
                重新连接
              </button>
            </div>
          )}
          {route === '/workflows' && (
            <WorkflowLibrary
              workflows={catalogue?.workflows ?? []}
              runs={runs}
              loading={!catalogue}
            />
          )}
          {selected && (
            <WorkflowPage
              key={selected.id}
              workflow={selected}
              onRun={() => setUpload(selected)}
            />
          )}
          {route.startsWith('/runs/') && (
            <RunPage
              key={route.split('/')[2]}
              id={route.split('/')[2]}
              workflows={catalogue?.workflows ?? []}
            />
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
createRoot(document.getElementById('root')!).render(<App />);
