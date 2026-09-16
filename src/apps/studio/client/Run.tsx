import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import {
  api,
  date,
  pretty,
  statusNames,
  terminal,
  type Artifact,
  type RunDetail,
  type RunView,
  type Workflow,
} from './api';
import { Graph, labels, type Selection } from './Graph';
import { outcomeNames } from './graph-model';
const PdfPreview = lazy(() => import('./PdfPreview'));
export function Json({ value }: { value: unknown }) {
  return <pre className="json">{pretty(value)}</pre>;
}
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {statusNames[status] ?? status}
    </span>
  );
}
export function Configuration({ value }: { value: any }) {
  const containers: any[] = [],
    seen = new Set<string>();
  const visit = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (v.options?.image) {
      const key = pretty(v.options);
      if (!seen.has(key)) {
        containers.push(v);
        seen.add(key);
      }
    }
    Object.values(v).forEach((child) => {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    });
  };
  visit(value);
  return (
    <>
      <div className="section-label">CONTAINER</div>
      {containers.length ? (
        containers.map((v, i) => (
          <section className="container-card" key={i}>
            <h4>容器 {i + 1}</h4>
            <dl>
              <dt>镜像</dt>
              <dd>{v.options.image}</dd>
              <dt>CPU</dt>
              <dd>{v.options.cpus ?? '未记录'}</dd>
              <dt>内存</dt>
              <dd>
                {v.options.memoryMiB ? v.options.memoryMiB + ' MiB' : '未记录'}
              </dd>
              <dt>网络</dt>
              <dd>
                {typeof v.options.network === 'string'
                  ? v.options.network
                  : pretty(v.options.network)}
              </dd>
              <dt>目录与挂载</dt>
              <dd>
                <Json
                  value={
                    v.paths ??
                    v.mounts ??
                    v.options.paths ?? {
                      input: '/task/input',
                      work: '/task/work',
                      outputs: '/task/outputs',
                      config: '/task/config（只读）',
                      state: '/task/state',
                      note: '容器执行的固定任务目录；宿主绑定见完整设置',
                    }
                  }
                />
              </dd>
            </dl>
          </section>
        ))
      ) : (
        <p className="notice">
          这个节点未记录容器配置。宿主函数、并行调度节点或合成 Agent
          不使用任务容器；旧记录也可能缺少设置。
        </p>
      )}
      <details>
        <summary>完整的已保存设置</summary>
        <Json value={value} />
      </details>
    </>
  );
}
function Inspector({
  view,
  definition,
  selection,
  events,
  onClose,
  runs = [],
  childName,
  onOpenRun,
}: {
  view?: RunView;
  definition: any;
  selection: Selection;
  events: any[];
  onClose: () => void;
  runs?: RunDetail['runs'];
  childName?: (view: RunView) => string;
  onOpenRun?: (runId: string) => void;
}) {
  const [tab, setTab] = useState('detail'),
    [attempt, setAttempt] = useState(-1);
  useEffect(() => {
    setTab('detail');
    setAttempt(
      selection?.kind === 'node' && selection.nodeTaskId
        ? (view?.snapshot.steps
            .filter((s) => s.node === selection.id)
            .findIndex(
              (s) => s.result.identity.nodeTaskId === selection.nodeTaskId,
            ) ?? -1)
        : -1,
    );
  }, [selection?.id, selection?.kind, selection?.nodeTaskId, view?.runId]);
  if (!selection) return null;
  if (selection.kind === 'edge') {
    const route = definition.routes?.[Number(selection.id)];
    return (
      <aside className="inspector">
        <div className="row">
          <h3>连线详情</h3>
          <button
            className="icon-button"
            aria-label="关闭详情"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <dl>
          <dt>从哪里</dt>
          <dd>{labels[route.from] ?? route.from}</dd>
          <dt>到哪里</dt>
          <dd>
            {labels[route.to.node] ?? route.to.node ?? '结束：' + route.to.end}
          </dd>
          <dt>何时走这条线</dt>
          <dd>{outcomeNames[route.outcome] ?? route.outcome}</dd>
          <dt>返工次数限制</dt>
          <dd>
            {route.limit
              ? `最多 ${route.limit.max} 次；用尽后 ${route.limit.exhausted.end}`
              : '这条线没有单独次数限制'}
          </dd>
        </dl>
        <h4>传递的数据契约</h4>
        <Json
          value={{
            outputContract:
              view?.execution?.structure.components[route.from]?.outcomes[
                route.outcome
              ] ?? '运行前未记录',
            targetContract:
              view?.execution?.structure.components[route.to.node]
                ?.inputContract ??
              definition.outcomes?.[route.to.end] ??
              null,
          }}
        />
        <details>
          <summary>完整连线信息</summary>
          <Json value={route} />
        </details>
      </aside>
    );
  }
  const node = selection.id,
    all =
      view?.snapshot.steps
        .map((s, i) => ({ ...s, index: i }))
        .filter((s) => s.node === node) ?? [],
    chosen =
      attempt < 0 &&
      view?.snapshot.currentNode === node &&
      !terminal(view.snapshot.status)
        ? undefined
        : attempt < 0
          ? all.at(-1)
          : all[attempt];
  const component = view?.execution?.structure.components[node],
    binding = view?.execution?.bindings[node],
    values = (view?.values ?? []) as any[];
  const current = view?.snapshot.currentNode === node && attempt < 0;
  const pendingInvocation = current
    ? (view?.attempts as any[] | undefined)?.findLast(
        (a) => a.node === node && a.resultStep === null,
      )
    : undefined;
  const identity =
    chosen?.result.identity ??
    (current
      ? (view?.snapshot.currentIdentity ?? pendingInvocation?.identity)
      : null);
  const invocation = (view?.attempts as any[] | undefined)?.findLast(
    (a) =>
      a.node === node &&
      a.identity?.nodeTaskId === identity?.nodeTaskId &&
      a.identity?.attemptNumber === identity?.attemptNumber,
  );
  const children = invocation?.parallel?.children as
    { id: string; runId: string }[] | undefined;
  const log = events.filter(
    (e) =>
      identity &&
      e.content.identity?.nodeTaskId === identity.nodeTaskId &&
      e.content.kind !== 'artifact' &&
      e.content.kind !== 'queue',
  );
  return (
    <aside className="inspector">
      <div className="row">
        <div>
          <p className="eyebrow">NODE DETAILS</p>
          <h3>{labels[node] ?? node}</h3>
        </div>
        <button className="icon-button" aria-label="关闭详情" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="mono muted">{node}</p>
      {(all.length > 1 || (current && all.length > 0)) && (
        <label>
          本步骤的执行次数
          <select
            aria-label="本步骤的执行次数"
            value={attempt}
            onChange={(e) => setAttempt(Number(e.target.value))}
          >
            <option value={-1}>
              {current && !terminal(view!.snapshot.status)
                ? '正在执行的一次'
                : '最近一次'}
            </option>
            {all.map((s, i) => (
              <option key={i} value={i}>
                第 {i + 1} 次 · {s.result.identity.nodeTaskId}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="small-tabs">
        {[
          ['detail', '详情'],
          ['input', '输入'],
          ['output', '输出'],
          ['settings', '设置'],
          ['logs', '日志'],
        ].map(([k, t]) => (
          <button
            key={k}
            className={tab === k ? 'active' : ''}
            onClick={() => setTab(k)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'detail' && (
        <>
          <Badge
            status={
              current
                ? view!.snapshot.status
                : (chosen?.result.status ?? '尚未执行')
            }
          />
          {children && (
            <section className="node-children">
              <h4>
                本次并行子任务 <span>{children.length}</span>
              </h4>
              {children.map((child) => {
                const run = runs.find(
                  (r) => r.view.runId === child.runId,
                )?.view;
                return (
                  <button
                    key={child.runId}
                    disabled={!run}
                    onClick={() => onOpenRun?.(child.runId)}
                  >
                    <span>
                      {run ? (childName?.(run) ?? child.id) : child.id}
                    </span>
                    {run ? (
                      <Badge status={run.snapshot.status} />
                    ) : (
                      <small>此时尚无记录</small>
                    )}
                    <b aria-hidden="true">→</b>
                  </button>
                );
              })}
            </section>
          )}
          <dl>
            <dt>组件</dt>
            <dd>
              {component?.id ??
                definition.nodes?.[node]?.component ??
                '结束节点'}
            </dd>
            <dt>类型</dt>
            <dd>{component?.kind ?? '运行后显示实际绑定'}</dd>
            <dt>执行身份</dt>
            <dd>{identity ? <Json value={identity} /> : '尚未生成'}</dd>
            <dt>本次结果</dt>
            <dd>
              {chosen?.result.status === 'accepted'
                ? chosen.result.outcome
                : chosen?.result.status === 'failed'
                  ? chosen.result.code
                  : current
                    ? '正在执行'
                    : '还没有结果'}
            </dd>
          </dl>
          {view?.snapshot.issues.length ? (
            <div className="error">
              <Json value={view.snapshot.issues} />
            </div>
          ) : null}
          <p className="muted">
            返工会生成新的节点任务；同一任务重试会增加 attemptNumber。
          </p>
        </>
      )}
      {tab === 'input' && (
        <Json
          value={
            chosen
              ? chosen.index === 0
                ? values[0]?.value
                : view?.snapshot.steps[chosen.index - 1]?.result.status ===
                    'accepted'
                  ? (view.snapshot.steps[chosen.index - 1].result as any).output
                  : null
              : current
                ? values.at(-1)?.value
                : '尚未记录输入'
          }
        />
      )}
      {tab === 'output' && (
        <>
          <p className="muted">
            {view?.snapshot.workflowId === 'recruitment'
              ? '这里是这一步的输出。最终招聘报告须等交付关卡通过。'
              : '这里是本步骤已保存的输出。'}
          </p>
          <Json
            value={
              chosen?.result.status === 'accepted'
                ? chosen.result.output
                : (chosen?.result ?? '尚未记录输出')
            }
          />
        </>
      )}
      {tab === 'settings' && (
        <Configuration
          value={{
            binding: binding ?? null,
            resources: view?.execution?.resourcePlans[node] ?? null,
            unavailable: view?.execution?.unavailable?.[node] ?? null,
          }}
        />
      )}
      {tab === 'logs' && (
        <>
          <p className="muted">
            {log.length
              ? `${log.length} 条已加载记录`
              : '未保存内部日志，或本节点尚未执行。'}{' '}
            公开消息与工具事件会按原样脱敏记录；不提供隐藏 CoT。
          </p>
          {log.map((e) => (
            <details className="log-entry" key={e.sequence}>
              <summary>
                {date(e.recordedAt)} · {e.content.kind}
              </summary>
              <Json value={e.content.data ?? e.content} />
            </details>
          ))}
        </>
      )}
    </aside>
  );
}
export function WorkflowCanvas({
  definition,
  title,
}: {
  definition: any;
  title: string;
}) {
  const [selection, setSelection] = useState<Selection>(null);
  return (
    <div className="canvas-layout">
      <Graph
        key={title}
        definition={definition}
        selection={selection}
        onSelect={setSelection}
        storageKey={'workflow-' + title}
      />
      <Inspector
        definition={definition}
        selection={selection}
        events={[]}
        onClose={() => setSelection(null)}
      />
    </div>
  );
}
export function RunPage({
  id,
  workflows,
}: {
  id: string;
  workflows: Workflow[];
}) {
  const [detail, setDetail] = useState<RunDetail>(),
    [error, setError] = useState(''),
    [selection, setSelection] = useState<Selection>(null),
    [selectedRun, setSelectedRun] = useState(''),
    [tab, setTab] = useState('canvas');
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [tab]);
  const [events, setEvents] = useState<any[]>([]),
    [nextEvents, setNextEvents] = useState<number | null>(null),
    [history, setHistory] = useState<any[]>([]),
    [nextHistory, setNextHistory] = useState<number | null>(null),
    [replay, setReplay] = useState<RunView>(),
    [position, setPosition] = useState(-1),
    [playing, setPlaying] = useState(false),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [file, setFile] = useState<Artifact>(),
    [text, setText] = useState('');
  const [cutoff, setCutoff] = useState<number | null>(),
    [seeking, setSeeking] = useState(false);
  const seekRequest = useRef(0),
    historyRun = useRef('');
  const [historicalRuns, setHistoricalRuns] = useState<RunDetail['runs']>();
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const data = await api<RunDetail>('runs/' + id);
        if (!alive) return;
        setDetail(data);
        setError('');
        const main = data.runs.find(
          (r) => !r.view.runId.startsWith('parallel-'),
        );
        if (!terminal(main?.view.snapshot.status ?? '') && !data.completion)
          timer = setTimeout(refresh, 1500);
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          timer = setTimeout(refresh, 3000);
        }
      }
    };
    setDetail(undefined);
    setSelectedRun('');
    setReplay(undefined);
    setPosition(-1);
    setCutoff(undefined);
    setHistoricalRuns(undefined);
    refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);
  const original =
    detail?.runs.find((r) => r.view.runId === selectedRun)?.view ??
    detail?.runs.find((r) => r.view.runId === detail.meta.mainRunId)?.view ??
    detail?.runs.find((r) => !r.view.runId.startsWith('parallel-'))?.view;
  const view = replay ?? original,
    runId = original?.runId;
  useEffect(() => {
    if (!runId || (cutoff !== undefined && historyRun.current === runId))
      return;
    if (historyRun.current !== runId) {
      setHistory([]);
      setNextHistory(null);
      setEvents([]);
      setNextEvents(null);
      setPlaying(false);
    }
    historyRun.current = runId;
    let alive = true;
    const base = `runs/${id}/`;
    Promise.all([
      api<any>(base + 'events?run=' + encodeURIComponent(runId)),
      api<any>(base + 'history?run=' + encodeURIComponent(runId)),
    ])
      .then(([logs, rows]) => {
        if (!alive) return;
        setEvents(logs.entries);
        setNextEvents(logs.next);
        setHistory(rows.entries);
        setNextHistory(rows.next);
        if (cutoff != null)
          setPosition(
            rows.entries.findLastIndex(
              (r: any) => r.recordedAt !== null && r.recordedAt <= cutoff,
            ),
          );
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id, runId, original?.revision]);
  useEffect(() => {
    let alive = true;
    if (cutoff === null) {
      setArtifacts([]);
      return;
    }
    api<any>(`runs/${id}/files` + (cutoff === undefined ? '' : '?at=' + cutoff))
      .then((data) => {
        if (alive) setArtifacts(data.files);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id, original?.revision, cutoff]);
  useEffect(() => {
    if (
      !file ||
      (!file.mediaType.startsWith('text/') &&
        file.mediaType !== 'application/json')
    )
      return;
    let alive = true;
    setText('正在读取…');
    fetch(`/api/runs/${id}/file/${file.id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? '文件无法读取');
        return r.text();
      })
      .then((t) => {
        if (alive) setText(t);
      })
      .catch((e) => {
        if (alive) setText('文件不可用：' + e.message);
      });
    return () => {
      alive = false;
    };
  }, [file?.id, id]);
  const seek = async (index: number) => {
    const request = ++seekRequest.current;
    if (index < 0) {
      setPosition(-1);
      setCutoff(undefined);
      setReplay(undefined);
      setHistoricalRuns(undefined);
      setFile(undefined);
      setSeeking(false);
      return;
    }
    const row = history[index];
    if (!row) return;
    setSeeking(true);
    try {
      const [data, group] = await Promise.all([
        api<any>(
          `runs/${id}/revision?run=${encodeURIComponent(runId!)}&revision=${row.revision}`,
        ),
        row.recordedAt !== null
          ? api<any>(`runs/${id}/at?time=${row.recordedAt}`)
          : Promise.resolve({ runs: [] }),
      ]);
      if (request !== seekRequest.current) return;
      setPosition(index);
      setReplay(data.view);
      setCutoff(row.recordedAt);
      setHistoricalRuns(
        group.runs.map((r: RunDetail['runs'][number]) =>
          r.view.runId === data.view.runId ? { ...r, view: data.view } : r,
        ),
      );
      setArtifacts([]);
      setFile(undefined);
    } catch (e) {
      if (request === seekRequest.current) {
        setError((e as Error).message);
        setPlaying(false);
      }
    } finally {
      if (request === seekRequest.current) setSeeking(false);
    }
  };
  useEffect(() => {
    if (!playing || seeking) return;
    if (position >= history.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      void seek(position + 1);
    }, 850);
    return () => clearTimeout(timer);
  }, [playing, seeking, position, history.length]);
  const loadMore = async (kind: 'events' | 'history') => {
    try {
      const data = await api<any>(
        `runs/${id}/${kind}?run=${encodeURIComponent(runId!)}&after=${kind === 'events' ? nextEvents : nextHistory}`,
      );
      if (kind === 'events') {
        setEvents((v) => [...v, ...data.entries]);
        setNextEvents(data.next);
      } else {
        setHistory((v) => [...v, ...data.entries]);
        setNextHistory(data.next);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const nodes = view?.execution?.structure.workflow,
    runs = historicalRuns ?? detail?.runs ?? [];
  const parent = (historicalRuns ?? detail?.runs)?.find(
    (r) => !r.view.runId.startsWith('parallel-'),
  )?.view;
  const final =
    parent?.snapshot.status === 'succeeded' &&
    parent.snapshot.outcome === 'completed' &&
    parent.snapshot.lastAccepted?.result.status === 'accepted'
      ? (parent.snapshot.lastAccepted.result.output as any)
      : null;
  const candidateName = (v: RunView) => {
    const input = (v.values[0] as any)?.value;
    const person = input?.candidateId;
    return person
      ? `${(final?.candidates ?? (parent?.values[0] as any)?.value?.candidates)?.find((c: any) => c.id === person)?.name ?? person} · ${input?.dimension ?? (v.snapshot.workflowId.startsWith('audits-') ? '独立复核' : v.snapshot.workflowId.startsWith('decisions-') ? '二元推荐' : v.snapshot.workflowId)}`
      : v.snapshot.workflowId;
  };
  const workflow = workflows.find((w) => w.id === detail?.meta.workflowId);
  const openRun = (target: string) => {
    ++seekRequest.current;
    setSeeking(false);
    setSelectedRun(target);
    setSelection(null);
    setReplay(
      cutoff === undefined
        ? undefined
        : historicalRuns?.find((r) => r.view.runId === target)?.view,
    );
    setPosition(-1);
    setFile(undefined);
    setPlaying(false);
    setTab('canvas');
  };
  const owner = parent?.attempts.find((a: any) =>
    a.parallel?.children.some((c: any) => c.runId === runId),
  ) as any;
  if (!detail)
    return (
      <div className="empty-page">
        <h2>{error ? '连接暂时中断' : '正在打开运行记录…'}</h2>
        <p>{error || '本机记录正在读取'}</p>
      </div>
    );
  return (
    <section
      className={'run-workspace ' + (tab === 'canvas' ? 'canvas-active' : '')}
    >
      <header className="page-header workspace-header">
        <a
          className="back-workflows"
          href={workflow ? '#/workflows/' + workflow.id : '#/history'}
          aria-label="返回所属工作流"
        >
          ←
        </a>
        <div className="workspace-title">
          <a
            className="run-workflow-link"
            href={workflow ? '#/workflows/' + workflow.id : '#/history'}
          >
            {workflow?.title ?? detail.meta.workflowId} <span>/ 本次运行</span>
          </a>
          <h1>{detail.meta.title}</h1>
          <span>
            {date(detail.meta.createdAt)} ·{' '}
            {detail.meta.fixture
              ? '合成测试响应'
              : detail.meta.source === 'cli'
                ? '原 CLI 入口'
                : '本机真实运行'}
          </span>
        </div>
        <Badge
          status={
            !replay &&
            detail.completion?.error &&
            !terminal(view?.snapshot.status ?? '')
              ? 'failed'
              : (view?.snapshot.status ??
                (detail.completion?.error ? 'failed' : 'queued'))
          }
        />
      </header>
      {error && (
        <div className="error" role="alert">
          连接或数据出现问题：{error}
        </div>
      )}
      {!replay && detail.completion?.error && (
        <div className="error">{detail.completion.error}</div>
      )}
      {view?.snapshot.outcome === 'rejected' && (
        <div className="notice">
          流程已结束，但输出未通过业务校验。请查看检查节点的返工原因。
        </div>
      )}
      {view?.snapshot.reason && (
        <div className="notice">
          {view.snapshot.reason}{' '}
          {view.snapshot.status === 'failed' &&
            '· 执行失败不会自动变成候选人不通过。'}
        </div>
      )}
      <div className="run-summary">
        <div>
          <span>步骤执行</span>
          <strong>{view?.snapshot.steps.length ?? 0}</strong>
        </div>
        <div>
          <span>
            {terminal(view?.snapshot.status ?? '') ? '最后步骤' : '当前步骤'}
          </span>
          <strong>
            {labels[
              view?.snapshot.currentNode ??
                view?.snapshot.steps.at(-1)?.node ??
                ''
            ] ??
              view?.snapshot.currentNode ??
              view?.snapshot.steps.at(-1)?.node ??
              '等待执行'}
          </strong>
        </div>
        <div>
          <span>并行子任务</span>
          <strong>{Math.max(0, runs.length - 1)}</strong>
        </div>
        <div>
          <span>文件</span>
          <strong>{artifacts.length}</strong>
        </div>
      </div>
      <div className="tabs">
        {[
          ['canvas', '工作流画布'],
          ['tasks', '步骤与并行任务'],
          ['results', '结果与报告'],
          ['files', '文件'],
          ['logs', '运行日志'],
          ['settings', '本次设置'],
        ].map(([k, title]) => (
          <button
            key={k}
            className={tab === k ? 'active' : ''}
            onClick={() => setTab(k)}
          >
            {title}
          </button>
        ))}
      </div>
      {detail.runs.length > 1 && (
        <div className="run-picker">
          <button
            className={runId === parent?.runId ? 'scope-current' : ''}
            onClick={() => parent && openRun(parent.runId)}
          >
            主流程
          </button>
          {runId !== parent?.runId && (
            <>
              <span className="scope-divider">/</span>
              <button
                onClick={() => {
                  if (parent) {
                    openRun(parent.runId);
                    if (owner)
                      setSelection({
                        kind: 'node',
                        id: owner.node,
                        nodeTaskId: owner.identity.nodeTaskId,
                      });
                  }
                }}
              >
                {labels[owner?.node] ?? owner?.node ?? '并行节点'}
              </button>
              <span className="scope-divider">/</span>
            </>
          )}
          <select
            aria-label="查看步骤范围"
            value={runId ?? ''}
            onChange={(e) => openRun(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.key} value={r.view.runId}>
                {r.view.runId === parent?.runId
                  ? '全部主流程步骤'
                  : candidateName(r.view)}{' '}
                · {r.view.runId.slice(-7)}
              </option>
            ))}
          </select>
        </div>
      )}
      {tab === 'canvas' &&
        (nodes ? (
          <div className="canvas-layout">
            <Graph
              key={runId}
              definition={nodes}
              view={view}
              selection={selection}
              onSelect={setSelection}
              storageKey={id + '-' + runId}
            />
            <Inspector
              definition={nodes}
              view={view}
              selection={selection}
              events={events.filter(
                (e) =>
                  cutoff === undefined ||
                  (cutoff !== null && e.recordedAt <= cutoff),
              )}
              onClose={() => setSelection(null)}
              runs={runs}
              childName={candidateName}
              onOpenRun={openRun}
            />
          </div>
        ) : (
          <div className="empty-page">
            <h3>等待第一条运行记录</h3>
            <p>若旧数据没有保存结构，页面会保留缺失说明。</p>
          </div>
        ))}
      <section className={`replay-bar ${replay ? 'replaying' : ''}`}>
        <div className="row">
          <strong>{replay ? '历史回放' : '当前记录'}</strong>
          <span>
            {position >= 0
              ? date(history[position]?.recordedAt)
              : '按保存顺序和实际时间查看'}
          </span>
          <small>回放只查看，不执行</small>
        </div>
        <div className="replay-controls">
          <button
            className="secondary"
            disabled={!history.length}
            onClick={() => {
              if (position >= history.length - 1) void seek(0);
              setPlaying((v) => !v);
            }}
          >
            {playing ? '暂停' : '播放'}
          </button>
          <button
            className="secondary"
            disabled={position <= 0}
            onClick={() => {
              setPlaying(false);
              void seek(position - 1);
            }}
          >
            上一步
          </button>
          <input
            aria-label="回放进度"
            type="range"
            min={0}
            max={Math.max(0, history.length - 1)}
            value={position < 0 ? Math.max(0, history.length - 1) : position}
            disabled={!history.length}
            onChange={(e) => {
              setPlaying(false);
              void seek(Number(e.target.value));
            }}
          />
          <button
            className="secondary"
            disabled={position >= history.length - 1}
            onClick={() => {
              setPlaying(false);
              void seek(position + 1);
            }}
          >
            下一步
          </button>
          <button
            className="text-button"
            onClick={() => {
              setPlaying(false);
              void seek(-1);
            }}
          >
            回到当前
          </button>
        </div>
        {replay && cutoff === null && (
          <p className="notice">
            这条旧记录没有保存时间；仅能查看本修订，不能对齐子运行、文件和日志。
          </p>
        )}
        {nextHistory && (
          <button className="text-button" onClick={() => loadMore('history')}>
            加载更后的历史记录
          </button>
        )}
      </section>
      {tab === 'tasks' && (
        <section className="panel">
          <h3>并行任务</h3>
          <p className="muted">
            每行来自独立子运行；点开后可查看该候选人的步骤、尝试与日志。
          </p>
          <div className="task-grid">
            {runs.map((r) => (
              <button
                className="child-run"
                key={r.key}
                onClick={() => openRun(r.view.runId)}
              >
                <strong>
                  {r.view.runId === parent?.runId
                    ? '主工作流'
                    : candidateName(r.view)}
                </strong>
                <Badge status={r.view.snapshot.status} />
                <small>{r.view.runId.slice(-12)}</small>
              </button>
            ))}
          </div>
          <h3>执行步骤</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>步骤</th>
                  <th>节点任务</th>
                  <th>尝试</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {view?.snapshot.steps.map((s, i) => (
                  <tr
                    key={i}
                    onClick={() => {
                      setSelection({ kind: 'node', id: s.node });
                      setTab('canvas');
                    }}
                  >
                    <td>{labels[s.node] ?? s.node}</td>
                    <td>{s.result.identity.nodeTaskId}</td>
                    <td>{s.result.identity.attemptNumber}</td>
                    <td>
                      {s.result.status === 'accepted'
                        ? s.result.outcome
                        : s.result.code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>全部尝试（包括重试等待）</h3>
          {view?.attempts.map((a: any, i) => (
            <details key={i}>
              <summary>
                {a.node} · {a.identity?.nodeTaskId} · 第{' '}
                {a.identity?.attemptNumber} 次 {a.retry ? '· 等待重试' : ''}
              </summary>
              <Json value={a} />
            </details>
          ))}
        </section>
      )}
      {tab === 'results' && (
        <section className="panel">
          <h2>结果与报告</h2>
          {final?.recommendations ? (
            <>
              <p className="muted">逐项结论与原文证据；没有总分或排名。</p>
              <div className="table-wrap">
                <table className="comparison">
                  <thead>
                    <tr>
                      <th>候选人</th>
                      <th>最终推荐</th>
                      <th>理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {final.recommendations.map((r: any) => (
                      <tr key={r.candidateId}>
                        <td>
                          {
                            final.candidates.find(
                              (c: any) => c.id === r.candidateId,
                            )?.name
                          }
                        </td>
                        <td>
                          <span
                            className={
                              'recommendation ' +
                              (r.recommendation === '推荐通过' ? 'yes' : 'no')
                            }
                          >
                            {r.recommendation}
                          </span>
                        </td>
                        <td>
                          <p className="comparison-reason">{r.rationale}</p>
                          <button
                            className="text-button"
                            onClick={() =>
                              document
                                .getElementById('candidate-' + r.candidateId)
                                ?.scrollIntoView({ behavior: 'smooth' })
                            }
                          >
                            查看逐项证据 ↓
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {final.recommendations.map((r: any) => (
                <section
                  className="candidate-report"
                  id={'candidate-' + r.candidateId}
                  key={r.candidateId}
                >
                  <h3>
                    {
                      final.candidates.find((c: any) => c.id === r.candidateId)
                        ?.name
                    }{' '}
                    <span
                      className={
                        'recommendation ' +
                        (r.recommendation === '推荐通过' ? 'yes' : 'no')
                      }
                    >
                      {r.recommendation}
                    </span>
                  </h3>
                  <details className="rationale">
                    <summary>查看完整推荐理由</summary>
                    <p>{r.rationale}</p>
                  </details>
                  {r.uncertaintyImpact && (
                    <div className="notice">{r.uncertaintyImpact}</div>
                  )}
                  {r.criteria.map((c: any) => (
                    <div className="criterion" key={c.requirementId}>
                      <div className="row">
                        <strong>
                          {final.requirements.find(
                            (q: any) => q.id === c.requirementId,
                          )?.label ?? c.requirementId}
                        </strong>
                        <span>{c.state}</span>
                      </div>
                      <p>{c.reason}</p>
                      {c.evidence.map((e: any, i: number) => (
                        <blockquote key={i}>
                          <p>“{e.quote}”</p>
                          <small>
                            {final.documents.find(
                              (d: any) => d.id === e.documentId,
                            )?.name ?? e.documentId}{' '}
                            · 第 {e.page} 页
                          </small>
                        </blockquote>
                      ))}
                    </div>
                  ))}
                  <h4>面试核实问题</h4>
                  <ul>
                    {r.questions.map((q: string, i: number) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                  <div className="row">
                    {artifacts
                      .filter((f) => f.name === `reports/${r.candidateId}.pdf`)
                      .map((f) => (
                        <button
                          key={f.id}
                          className="secondary"
                          onClick={() => {
                            setFile(f);
                            setTab('files');
                          }}
                        >
                          查看个人 PDF ↗
                        </button>
                      ))}
                  </div>
                </section>
              ))}
            </>
          ) : (
            <>
              <p className="notice">
                {detail.meta.workflowId === 'recruitment'
                  ? '尚无经过交付关卡的最终招聘报告。执行失败、取消或未通过校验，不等于候选人被判不通过。'
                  : '以下为当前工作流已保存的输出；文件产物请在“文件”页查看。'}
              </p>
              <Json value={view?.snapshot.lastAccepted?.result ?? '暂无输出'} />
            </>
          )}
        </section>
      )}
      {tab === 'files' && (
        <section className="files-layout">
          <div className="panel file-list">
            <h3>文件 · {artifacts.length}</h3>
            <p className="muted">
              节点契约通过只代表本步骤格式有效；最终报告见“结果与报告”。
            </p>
            {artifacts.length === 0 && <p>尚无文件记录，或原文件不可用。</p>}
            {artifacts.map((f) => (
              <button
                className={`file-row ${file?.id === f.id ? 'active' : ''}`}
                key={f.id}
                onClick={() => setFile(f)}
              >
                <strong>{f.name}</strong>
                <small>
                  {Math.ceil(f.bytes / 1024)} KB ·{' '}
                  {f.nodeTaskId
                    ? `${detail.runs.find((r) => r.view.runId === f.runId)?.view.runId === parent?.runId ? '主工作流' : detail.runs.find((r) => r.view.runId === f.runId) ? candidateName(detail.runs.find((r) => r.view.runId === f.runId)!.view) : f.runId} · ${f.nodeTaskId}`
                    : '原始输入 / 历史文件'}
                </small>
                <span className={f.accepted ? '' : 'draft'}>
                  {f.unavailable
                    ? '归档不可用'
                    : f.accepted
                      ? '节点输出 / 输入'
                      : '未接纳的草稿'}
                </span>
              </button>
            ))}
          </div>
          <div className="panel preview">
            {file?.unavailable ? (
              <div className="error" role="alert">
                {file.unavailable}
              </div>
            ) : file ? (
              <>
                <div className="row">
                  <h3>{file.name}</h3>
                  <a
                    className="secondary"
                    href={`/api/runs/${id}/file/${file.id}?download=1`}
                  >
                    下载文件 ↓
                  </a>
                </div>
                <p className="muted mono">SHA256 {file.sha256}</p>
                {file.mediaType === 'application/pdf' ? (
                  <Suspense fallback={<p>正在读取 PDF 查看器…</p>}>
                    <PdfPreview
                      key={file.id}
                      name={file.name}
                      url={`/api/runs/${id}/file/${file.id}`}
                    />
                  </Suspense>
                ) : file.mediaType.startsWith('image/') ? (
                  <img
                    alt={file.name}
                    src={`/api/runs/${id}/file/${file.id}`}
                  />
                ) : file.mediaType.startsWith('text/') ||
                  file.mediaType === 'application/json' ? (
                  <pre className="text-preview">{text}</pre>
                ) : (
                  <p>此格式请下载后查看。</p>
                )}
              </>
            ) : (
              <div className="empty-page">
                <h3>选择一份文件</h3>
                <p>支持文本、JSON、图片和 PDF 预览。</p>
              </div>
            )}
          </div>
        </section>
      )}
      {tab === 'logs' && (
        <section className="panel">
          <h3>事件与执行日志</h3>
          <p className="muted">
            只显示已保存的公开记录。session memory
            未启用时标为关闭；捕获失败或超限会保留提示。
          </p>
          {events.length === 0 && (
            <div className="notice">
              此运行尚未记录日志；旧入口可能只有节点输入、输出和状态。
            </div>
          )}
          {events
            .filter(
              (e) =>
                cutoff === undefined ||
                (cutoff !== null && e.recordedAt <= cutoff),
            )
            .map((e) => (
              <details className="log-entry" key={e.sequence}>
                <summary>
                  <span className="mono">#{e.sequence}</span>{' '}
                  {date(e.recordedAt)} ·{' '}
                  {e.content.identity?.nodeTaskId ?? '工作流'} ·{' '}
                  {e.content.kind}
                </summary>
                <Json value={e.content.data ?? e.content} />
              </details>
            ))}
          {nextEvents && (
            <button className="secondary" onClick={() => loadMore('events')}>
              加载更多日志
            </button>
          )}
        </section>
      )}
      {tab === 'settings' && (
        <section className="panel">
          <h3>这次运行实际使用的设置</h3>
          <p className="muted">
            后来的配置修改不会替换本次保存的定义。首版页面只查看技术设置。
          </p>
          <Configuration value={view?.execution ?? null} />
          <details>
            <summary>启动时的本机配置</summary>
            <Json value={detail.meta.settings ?? '旧 CLI 未保存额外启动配置'} />
          </details>
          {view?.missing.map((m, i) => (
            <p key={i} className="notice">
              {m}
            </p>
          ))}
        </section>
      )}
    </section>
  );
}
