import { useEffect, useLayoutEffect, useState, useRef } from 'react';
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
import { NodeTask, TaskRequirements, taskFacts } from './NodeTask';
import type { TaskNote } from './api';
import type { RunTimeline } from './api';
import { attemptTiming, attemptDuration, clockTime, duration, isRecruitmentOutput, sameAttempt, timestamp } from './presentation';
import { Timing } from './Timing';
import { Files } from './Files';
import { ArtifactCards, OutputValue } from './Outputs';
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
export function Configuration({ value, historical = true, note }: { value: any; historical?: boolean; note?: TaskNote }) {
  const containers: { definition: any; role: string }[] = [],
    seen = new Set<string>();
  const visit = (v: any, role = '任务执行') => {
    if (!v || typeof v !== 'object') return;
    if (v.options?.image) {
      const key = role + pretty(v.options);
      if (!seen.has(key)) {
        containers.push({ definition: v, role });
        seen.add(key);
      }
    }
    Object.entries(v).forEach(([key, child]) => {
      const nextRole = key === 'versionProbe' || v.id === 'version' ? '版本检查' : role;
      if (Array.isArray(child)) child.forEach(item => visit(item, nextRole));
      else if (child && typeof child === 'object') visit(child, nextRole);
    });
  };
  visit(value);
  if (!containers.length && note?.container) containers.push({ definition: { options: note.container }, role: '已声明的任务容器（镜像未解析）' });
  return (
    <>
      <div className="task-source"><span>{historical ? '本次运行已保存' : '当前流程定义'}</span><b>容器配置</b></div>
      {containers.length ? (
        containers.sort((a, b) => a.role === b.role ? 0 : a.role === '任务执行' ? -1 : 1).map(({ definition: v, role }, i) => (
          <section className="container-card" key={i}>
            <h4>{role}</h4>
            <dl>
              <dt>镜像</dt>
              <dd>{v.options.image}</dd>
              <dt>CPU</dt>
              <dd>{v.options.cpus ?? (historical ? '未记录' : '使用默认值')}</dd>
              <dt>内存</dt>
              <dd>
                {v.options.memoryMiB ? v.options.memoryMiB + ' MiB' : historical ? '未记录' : '使用默认值'}
              </dd>
              <dt>网络</dt>
              <dd>
                {v.options.network === 'none' ? '不联网（none）'
                  : v.options.network?.kind === 'connect-proxy' ? `受控代理 · ${v.options.network.allowedHosts?.join('、') ?? '未提供目标'}`
                    : pretty(v.options.network)}
              </dd>
              <dt>目录与挂载</dt>
              <dd>
                <details><summary>查看任务目录</summary><Json
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
                /></details>
              </dd>
            </dl>
          </section>
        ))
      ) : (
        <p className="notice">
          {taskFacts(value?.binding, note).fixture ? '此节点使用合成执行器，不启动任务容器。'
            : note?.mode === 'host' || note?.mode === 'parallel' ? '此节点由宿主程序执行，不使用任务容器。'
              : note?.deferred ? note.deferred
                : historical ? '这份运行记录未保存可展示的容器配置。' : '暂时无法读取容器配置，请检查本机环境与镜像。'}
        </p>
      )}
      <details>
        <summary>{historical ? '完整的已保存设置' : '完整的当前设置'}</summary>
        <Json value={value} />
      </details>
    </>
  );
}
function Inspector({
  view,
  workflow,
  definition,
  selection,
  events,
  onClose,
  runs = [],
  childName,
  onOpenRun,
  timeline,
}: {
  view?: RunView;
  workflow?: Workflow;
  definition: any;
  selection: Selection;
  events: any[];
  onClose: () => void;
  runs?: RunDetail['runs'];
  childName?: (view: RunView) => string;
  onOpenRun?: (runId: string) => void;
  timeline?: RunTimeline;
}) {
  const panel = useRef<HTMLElement>(null);
  const [tab, setTab] = useState('task'),
    [attempt, setAttempt] = useState(-1);
  useLayoutEffect(() => { panel.current?.scrollTo(0, 0); }, [tab, selection?.id, selection?.kind, view?.runId]);
  useEffect(() => {
    setTab('task');
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
  useEffect(() => {
    if (selection?.kind !== 'node') return;
    const count = view?.snapshot.steps.filter(s => s.node === selection.id).length ?? 0;
    setAttempt(value => value >= count ? -1 : value);
  }, [view?.revision, view?.runId, selection?.id, selection?.kind]);
  if (!selection) return null;
  // A historical view must never fall back to today's catalogue metadata.
  const execution = view ? view.execution : workflow?.execution;
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
              execution?.structure?.components[route.from]?.outcomes[
                route.outcome
              ] ?? '未提供',
            targetContract:
              execution?.structure?.components[route.to.node]
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
  const component = execution?.structure?.components[node],
    binding = execution?.bindings?.[node],
    note = view ? undefined : workflow?.tasks?.[node],
    values = (view?.values ?? []) as any[];
  const current = view?.snapshot.currentNode === node && attempt < 0;
  const pendingInvocation = current
    ? (view?.attempts as any[] | undefined)?.findLast(
        (a) => a.node === node && a.resultStep === null,
      )
    : undefined;
  const identity =
    (current && attempt < 0 && !terminal(view!.snapshot.status) ? view?.snapshot.currentIdentity ?? pendingInvocation?.identity : null) ?? chosen?.result.identity ??
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
      sameAttempt(e.content.identity, identity) &&
      e.content.kind !== 'artifact' &&
      e.content.kind !== 'queue',
  );
  const output =
    chosen?.result.status === 'accepted' ? chosen.result.output : undefined;
  const nodeTime = attemptTiming(timeline?.attempts, identity);
  const generatedKeys =
    view?.snapshot.workflowId === 'recruitment'
      ? node === 'match'
        ? ['requirements', 'recommendations', 'analysisIssues']
        : node === 'audit'
          ? ['audits', 'repairReasons', 'round']
          : null
      : null;
  const generated =
    generatedKeys && output && typeof output === 'object' && !Array.isArray(output)
      ? Object.fromEntries(generatedKeys.map((key) => [key, output[key]]))
      : null;
  return (
    <aside className="inspector" ref={panel}>
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
      {view && identity && <div className="node-time-strip" title="节点起止保存记录，包含准备、执行与清理">
        <span>{clockTime(nodeTime?.startedAt)} → {nodeTime && !nodeTime.ended ? '尚未结束' : clockTime(nodeTime?.finishedAt)}</span>
        <b>{attemptDuration(nodeTime, timeline?.updatedAt)}</b>
      </div>}
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
          ['task', '任务'],
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
      {tab === 'task' && <NodeTask key={node} binding={binding} note={note} component={component}
        execution={execution ?? undefined} historical={!!view} unavailable={execution?.unavailable?.[node]}
        end={!definition.nodes?.[node] ? node.replace(/^end-/, '') : undefined} />}
      {(tab === 'detail' || tab === 'task' && !!children) && (
        <>
          {view && <Timing value={nodeTime} at={timeline?.updatedAt} />}
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
                ? outcomeNames[chosen.result.outcome] ?? chosen.result.outcome
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
      {tab === 'input' && !view && <TaskRequirements direction="input" note={note} component={component} execution={execution ?? undefined} />}
      {tab === 'input' && !!view && (
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
      {tab === 'output' && !view && <TaskRequirements direction="output" note={note} component={component} execution={execution ?? undefined} />}
      {tab === 'output' && !!view && (
        <>
          <p className="muted">
            {view?.snapshot.workflowId === 'recruitment'
              ? '本步骤输出；最终报告在复核通过后生成。'
              : '这里是本步骤已保存的输出。'}
          </p>
          <Json value={generated ?? output ?? chosen?.result ?? '尚未记录输出'} />
          {generated && (
            <details>
              <summary>完整传递数据（含原始材料）</summary>
              <Json value={output} />
            </details>
          )}
        </>
      )}
      {tab === 'settings' && (
        <Configuration
          historical={!!view}
          note={note}
          value={{
            binding: binding ?? null,
            resources: execution?.resourcePlans?.[node] ?? null,
            unavailable: execution?.unavailable?.[node] ?? null,
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
  workflow,
}: {
  workflow: Workflow;
}) {
  const { definition, id: title } = workflow;
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
        workflow={workflow}
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
    [loadingEvents, setLoadingEvents] = useState(false),
    [history, setHistory] = useState<any[]>([]),
    [replay, setReplay] = useState<RunView>(),
    [position, setPosition] = useState(-1),
    [playing, setPlaying] = useState(false),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [file, setFile] = useState<Artifact>();
  const [timeline, setTimeline] = useState<RunTimeline>(), [replayTimeline, setReplayTimeline] = useState<RunTimeline>();
  const [cutoff, setCutoff] = useState<number | null>(),
    [seeking, setSeeking] = useState(false);
  const [cutoffSequence, setCutoffSequence] = useState<number>();
  const eventPages = useRef({ key: '', entries: [] as any[], next: null as number | null, busy: false, refresh: false });
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
    ++seekRequest.current;
    setDetail(undefined);
    setTimeline(undefined); setReplayTimeline(undefined);
    setSelectedRun('');
    setReplay(undefined);
    setPosition(-1);
    setCutoff(undefined); setCutoffSequence(undefined);
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
  const eventKey = `${id}:${runId ?? ''}`;
  if (eventPages.current.key !== eventKey)
    eventPages.current = { key: eventKey, entries: [], next: null, busy: false, refresh: false };
  // Every request belongs to one run cache. Late responses cannot mutate another run.
  const fetchEvents = async (more = false): Promise<void> => {
    const cache = eventPages.current;
    if (!runId || !more && cache.next !== null) return;
    if (cache.busy) { if (!more) cache.refresh = true; return; }
    cache.busy = true; setLoadingEvents(true);
    try {
      const after = cache.entries.at(-1)?.sequence ?? 0;
      const data = await api<any>(`runs/${id}/events?run=${encodeURIComponent(runId)}&after=${after}`);
      if (eventPages.current !== cache) return;
      cache.entries = [...new Map([...cache.entries, ...data.entries].map(e => [e.sequence, e])).values()].sort((a, b) => a.sequence - b.sequence);
      cache.next = data.next;
      setEvents(cache.entries); setNextEvents(cache.next);
    } catch (e) {
      if (eventPages.current === cache) setError((e as Error).message);
    } finally {
      cache.busy = false;
      if (eventPages.current === cache) {
        setLoadingEvents(false);
        if (cache.refresh) { cache.refresh = false; void fetchEvents(); }
      }
    }
  };
  useEffect(() => {
    if (!runId || (cutoff !== undefined && historyRun.current === eventKey))
      return;
    if (historyRun.current !== eventKey) {
      setHistory([]);
      setEvents([]);
      setNextEvents(null);
      setPlaying(false);
    }
    historyRun.current = eventKey;
    void fetchEvents();
    let alive = true;
    const base = `runs/${id}/`;
    Promise.all([
      api<RunTimeline>(base + 'timing?run=' + encodeURIComponent(runId)),
      cutoff != null ? api<RunTimeline>(base + 'timing?run=' + encodeURIComponent(runId) + '&at=' + cutoff + (cutoffSequence === undefined ? '' : '&sequence=' + cutoffSequence)) : Promise.resolve(undefined),
    ])
      .then(([times, pastTimes]) => {
        if (!alive) return;
        setTimeline(times); setReplayTimeline(pastTimes);
        setHistory(times.revisions);
        if (cutoff != null)
          setPosition(
            times.revisions.findLastIndex(
              (r: any) => r.recordedAt !== null && r.recordedAt <= cutoff && (cutoffSequence === undefined || r.sequence <= cutoffSequence),
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
    api<any>(`runs/${id}/files` + (cutoff === undefined ? '' : '?at=' + cutoff + (cutoffSequence === undefined ? '' : '&sequence=' + cutoffSequence)))
      .then((data) => {
        if (alive) setArtifacts(data.files);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id, original?.revision, cutoff, cutoffSequence]);
  const seek = async (index: number) => {
    const request = ++seekRequest.current;
    if (index < 0) {
      setPosition(-1);
      setCutoff(undefined); setCutoffSequence(undefined);
      setReplay(undefined); setReplayTimeline(undefined);
      setHistoricalRuns(undefined);
      setFile(undefined);
      setSeeking(false);
      return;
    }
    const row = history[index];
    if (!row) return;
    setSeeking(true);
    try {
      const [data, group, times] = await Promise.all([
        api<any>(
          `runs/${id}/revision?run=${encodeURIComponent(runId!)}&revision=${row.revision}`,
        ),
        row.recordedAt !== null
          ? api<any>(`runs/${id}/at?time=${row.recordedAt}&sequence=${row.sequence}`)
          : Promise.resolve({ runs: [] }),
        api<RunTimeline>(`runs/${id}/timing?run=${encodeURIComponent(runId!)}&revision=${row.revision}` + (row.recordedAt !== null ? `&at=${row.recordedAt}&sequence=${row.sequence}` : '')),
      ]);
      if (request !== seekRequest.current) return;
      setPosition(index);
      setReplay(data.view); setReplayTimeline(times);
      setCutoff(row.recordedAt); setCutoffSequence(row.sequence);
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
  const activeTimeline = cutoff === undefined ? timeline : replayTimeline;
  const currentPosition = position < 0 ? Math.max(0, history.length - 1) : position;
  const selectedTime = cutoff === undefined ? timeline?.updatedAt : cutoff;
  const nodes = view?.execution?.structure.workflow,
    runs = historicalRuns ?? detail?.runs ?? [];
  const parent = (historicalRuns ?? detail?.runs)?.find(
    (r) => !r.view.runId.startsWith('parallel-'),
  )?.view;
  const parentFinal =
    parent?.snapshot.status === 'succeeded' &&
    parent.snapshot.outcome === 'completed' &&
    parent.snapshot.lastAccepted?.result.status === 'accepted'
      ? (parent.snapshot.lastAccepted.result.output as any)
      : null;
  const candidateName = (v: RunView) => {
    const input = (v.values[0] as any)?.value;
    const person = input?.candidateId;
    return person
      ? `${(parentFinal?.candidates ?? (parent?.values[0] as any)?.value?.candidates)?.find((c: any) => c.id === person)?.name ?? person} · ${input?.dimension ?? (v.snapshot.workflowId.startsWith('audits-') ? '独立复核' : v.snapshot.workflowId.startsWith('decisions-') ? '二元推荐' : v.snapshot.workflowId)}`
      : v.snapshot.workflowId;
  };
  const final = view?.snapshot.status === 'succeeded' && view.snapshot.outcome !== 'rejected' && view.snapshot.lastAccepted?.result.status === 'accepted' ? view.snapshot.lastAccepted.result.output as any : null;
  const mainRun = runId === parent?.runId;
  const runStartedAt = mainRun ? detail?.meta.createdAt ?? timeline?.startedAt : timeline?.startedAt;
  const runFinishedAt = cutoff === undefined && mainRun ? detail?.completion?.finishedAt ?? activeTimeline?.finishedAt : activeTimeline?.finishedAt;
  const runEnded = terminal(view?.snapshot.status ?? '') || cutoff === undefined && mainRun && !!detail?.completion;
  const lastResult = view?.snapshot.lastAccepted?.result;
  const resultFiles = artifacts.filter(f => f.accepted && f.sources?.some(source => source.role === 'output' && source.runId === runId && (view?.snapshot.workflowId !== 'recruitment' || source.nodeTaskId === lastResult?.identity.nodeTaskId && source.attemptNumber === lastResult?.identity.attemptNumber)));
  const openFile = (f: Artifact) => { setFile(f); setTab('files'); };
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
    setTimeline(undefined); setReplayTimeline(undefined);
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
      className={'run-workspace ' + (tab === 'canvas' ? 'canvas-active' : tab === 'files' ? 'files-active' : '')}
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
      <div className="run-time-range" aria-label="运行时间">
        <span>开始 <time dateTime={runStartedAt == null ? undefined : new Date(runStartedAt).toISOString()}>{timestamp(runStartedAt)}</time></span>
        <span>结束 <time dateTime={!runEnded || runFinishedAt == null ? undefined : new Date(runFinishedAt).toISOString()}>{runEnded ? timestamp(runFinishedAt) : cutoff === undefined ? '尚未结束' : '当时尚未结束'}</time></span>
        <span>{runEnded ? '耗时' : '截至记录已用'} <b>{duration(runStartedAt, runEnded ? runFinishedAt : selectedTime)}</b></span>
        <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
      </div>
      <div className="tabs">
        {[
          ['canvas', '工作流画布'],
          ['tasks', '步骤与并行任务'],
          ['results', '结果与产物'],
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
              timeline={activeTimeline}
              selection={selection}
              onSelect={setSelection}
              storageKey={id + '-' + runId}
            />
            <Inspector
              definition={nodes}
              view={view}
              timeline={activeTimeline}
              selection={selection}
              events={events.filter(
                (e) =>
                  cutoff === undefined ||
                  (cutoff !== null && (cutoffSequence === undefined ? e.recordedAt <= cutoff : e.recordedAt < cutoff)),
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
              ? timestamp(history[position]?.recordedAt)
              : timestamp(selectedTime)}
          </span>
          <span className="replay-elapsed">已过去 {duration(timeline?.startedAt, selectedTime)}</span>
          <small>记录 {history.length ? currentPosition + 1 : 0} / {history.length} · 按记录播放</small>
        </div>
        <div className="replay-controls">
          <button
            className="secondary"
            disabled={!history.length}
            onClick={() => {
              if (position < 0 || position >= history.length - 1) void seek(0);
              setPlaying((v) => !v);
            }}
          >
            {playing ? '暂停' : '播放'}
          </button>
          <button
            className="secondary"
            disabled={!history.length || currentPosition <= 0 || seeking}
            onClick={() => {
              setPlaying(false);
              void seek(currentPosition - 1);
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
            disabled={!history.length || currentPosition >= history.length - 1 || seeking}
            onClick={() => {
              setPlaying(false);
              void seek(currentPosition + 1);
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
        <div className="replay-endpoints"><time>{timestamp(history[0]?.recordedAt)}</time><time>{timestamp(history.at(-1)?.recordedAt)}</time></div>
        {replay && cutoff === null && (
          <p className="notice">
            这条旧记录没有保存时间；仅能查看本修订，不能对齐子运行、文件和日志。
          </p>
        )}
      </section>
      {tab === 'tasks' && (
        <section className="panel">
          {runs.length > 1 && <><h3>运行与子任务</h3><div className="task-grid">
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
          </div></>}
          <h3>执行步骤</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>步骤</th>
                  <th>节点任务</th>
                  <th>尝试</th>
                  <th>结果</th><th>开始时间</th><th>结束时间</th><th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {view?.snapshot.steps.map((s, i) => (
                  <tr
                    key={i}
                    onClick={() => {
                      setSelection({ kind: 'node', id: s.node, nodeTaskId: s.result.identity.nodeTaskId });
                      setTab('canvas');
                    }}
                  >
                    <td><button className="text-button" onClick={() => {
                      setSelection({ kind: 'node', id: s.node, nodeTaskId: s.result.identity.nodeTaskId });
                      setTab('canvas');
                    }}>{labels[s.node] ?? s.node} ↗</button></td>
                    <td>{s.result.identity.nodeTaskId}</td>
                    <td>{s.result.identity.attemptNumber}</td>
                    <td>
                      {s.result.status === 'accepted'
                        ? outcomeNames[s.result.outcome] ?? s.result.outcome
                        : s.result.code}
                    </td>
                    <td className="time-cell">{timestamp(attemptTiming(activeTimeline?.attempts, s.result.identity)?.startedAt)}</td>
                    <td className="time-cell">{timestamp(attemptTiming(activeTimeline?.attempts, s.result.identity)?.finishedAt)}</td>
                    <td>{duration(attemptTiming(activeTimeline?.attempts, s.result.identity)?.startedAt, attemptTiming(activeTimeline?.attempts, s.result.identity)?.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>全部尝试（包括重试等待）</h3>
          {view?.attempts.map((a: any, i) => (
            <details key={i}>
              <summary>
                {labels[a.node] ?? a.node} · {a.identity?.nodeTaskId} · 第{' '}
                {a.identity?.attemptNumber} 次 {a.retry ? '· 等待重试' : ''}
              </summary>
              <Timing value={attemptTiming(activeTimeline?.attempts, a.identity)} at={activeTimeline?.updatedAt} />
              <details><summary>完整执行记录</summary><Json value={a} /></details>
            </details>
          ))}
        </section>
      )}
      {tab === 'results' && (
        <section className="panel">
          <div className="row"><h2>结果与产物</h2><span className="muted">{view?.snapshot.status === 'succeeded' ? '已结束' : '当前已保存输出'} · {outcomeNames[view?.snapshot.outcome ?? ''] ?? view?.snapshot.outcome ?? ''}</span></div>
          {!isRecruitmentOutput(view?.snapshot.workflowId, final) && <ArtifactCards files={resultFiles} onOpen={openFile} />}
          {isRecruitmentOutput(view?.snapshot.workflowId, final) ? (
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
              {view?.snapshot.workflowId === 'recruitment'
                ? <p className="notice">尚无经过交付关卡的最终招聘报告。执行失败、取消或未通过校验，不等于候选人被判不通过。</p>
                : <h3>工作流输出</h3>}
              <OutputValue value={lastResult?.status === 'accepted' ? lastResult.output : undefined} />
            </>
          )}
          {isRecruitmentOutput(view?.snapshot.workflowId, final) && <details><summary>全部交付文件 · {resultFiles.length}</summary><ArtifactCards files={resultFiles} onOpen={openFile} /></details>}
          {lastResult?.status === 'accepted' && <details className="raw-output"><summary>原始输出 JSON</summary><Json value={lastResult.output} /></details>}
        </section>
      )}
      {tab === 'files' && <Files id={id} files={artifacts} runs={runs} selected={file} onSelect={setFile}
        onNode={(targetRun, node, nodeTaskId) => { if (targetRun !== runId) openRun(targetRun); else setTab('canvas'); setSelection({ kind: 'node', id: node, nodeTaskId }); }} />}
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
                (cutoff !== null && (cutoffSequence === undefined ? e.recordedAt <= cutoff : e.recordedAt < cutoff)),
            )
            .map((e) => (
              <details className="log-entry" key={e.sequence}>
                <summary>
                  <span className="mono">#{e.sequence}</span>{' '}
                  {timestamp(e.recordedAt)} ·{' '}
                  {e.content.identity?.nodeTaskId ?? '工作流'} ·{' '}
                  {e.content.kind}
                </summary>
                <Json value={e.content.data ?? e.content} />
              </details>
            ))}
          {nextEvents && (
            <button className="secondary" disabled={loadingEvents} onClick={() => void fetchEvents(true)}>
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
