import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  applyNodeChanges,
  type NodeProps,
  type NodeChange,
  type Node,
  type Edge,
  type EdgeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { statusNames, terminal, type RunView } from './api';
import {
  graphLayout,
  nameOf,
  nodeNames,
  outcomeNames,
  routePorts,
} from './graph-model';
export const labels = nodeNames;
export type Selection = {
  kind: 'node' | 'edge';
  id: string;
  nodeTaskId?: string;
} | null;
const positions = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};
function TaskNode({ data, selected }: NodeProps) {
  const status = String(data.status ?? '');
  return (
    <div
      className={`task-node ${status} ${selected ? 'selected' : ''} ${data.end ? 'end' : ''}`}
      data-status={status}
    >
      {Object.entries(positions).flatMap(([key, position]) => [
        <Handle
          key={key + '-in'}
          id={key + '-in'}
          type="target"
          position={position}
        />,
        <Handle
          key={key + '-out'}
          id={key + '-out'}
          type="source"
          position={position}
        />,
      ])}
      <div className="node-top">
        <span className={`node-icon ${data.kind ?? ''}`}>
          {data.end
            ? status === 'succeeded'
              ? '✓'
              : status === 'rejected'
                ? '!'
                : '○'
            : data.kind === 'agent'
              ? '✦'
              : data.kind === 'gate'
                ? '◇'
                : data.parallel
                  ? '⑂'
                  : '▤'}
        </span>
        <span className="node-title">{String(data.label)}</span>
        <span className="node-number">
          {data.end ? 'END' : String(Number(data.index) + 1).padStart(2, '0')}
        </span>
      </div>
      <div className="node-sub">
        <span>{String(data.subtitle)}</span>
        {Number(data.count) > 1 && <b>执行 {String(data.count)} 次</b>}
      </div>
      {status && (
        <div className={`node-status ${status}`}>
          <i />
          {statusNames[status] ??
            (status === 'pending'
              ? '未执行'
              : status === 'rejected'
                ? '校验未通过'
                : status)}
        </div>
      )}
    </div>
  );
}
function ReturnEdge(props: EdgeProps) {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, data } = props;
  const lane = Number(data?.lane ?? -48),
    offset = Number(data?.offset ?? 35);
  const path = `M ${sx} ${sy} L ${sx} ${sy - offset} L ${lane} ${sy - offset} L ${lane} ${ty - offset} L ${tx} ${ty - offset} L ${tx} ${ty}`;
  return (
    <>
      <BaseEdge {...props} path={path} interactionWidth={24} />
      <EdgeLabelRenderer>
        <span
          className="return-label"
          style={{
            transform: `translate(-50%, -50%) translate(${lane}px, ${(sy + ty) / 2}px)`,
          }}
        >
          {String(props.label ?? '')}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = { task: TaskNode },
  edgeTypes = { repair: ReturnEdge };
export function Graph({
  definition,
  view,
  selection,
  onSelect,
  storageKey,
}: {
  definition: any;
  view?: RunView;
  selection: Selection;
  onSelect: (s: Selection) => void;
  storageKey: string;
}) {
  const initial = useMemo(() => graphLayout(definition), [definition]);
  const layoutKey = 'layout:v2:' + storageKey;
  const [nodes, setNodes] = useState<Node[]>([]),
    [instance, setInstance] = useState<ReactFlowInstance>(),
    [minimap, setMinimap] = useState(false);
  const initialized = useRef(''),
    framed = useRef('');
  const canvasElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      !instance ||
      !nodes.length ||
      nodes.some((n) => !n.measured?.width) ||
      framed.current === layoutKey
    )
      return;
    framed.current = layoutKey;
    // A phone opens on a readable starting node; the overview remains one click away.
    if ((canvasElement.current?.clientWidth ?? 0) < 850) {
      const start = nodes.find((n) => n.id === definition.start);
      if (start)
        void instance.setCenter(
          start.position.x + 118,
          start.position.y + 110,
          { zoom: 1 },
        );
    } else {
      const pane = canvasElement.current?.querySelector('.react-flow');
      const height = pane?.clientHeight ?? 0;
      const bottom = Math.max(
        ...nodes.map((n) => n.position.y + (n.measured?.height ?? 116)),
      );
      const top = Math.min(...nodes.map((n) => n.position.y));
      if (height > 0 && (bottom - top) * 0.78 > height) {
        const left = Math.min(...nodes.map((n) => n.position.x));
        const right = Math.max(
          ...nodes.map((n) => n.position.x + (n.measured?.width ?? 236)),
        );
        void instance.setViewport({
          x:
            ((pane?.clientWidth ?? 0) - (right - left) * 0.85) / 2 -
            left * 0.85,
          y: 44 - top * 0.85,
          zoom: 0.85,
        });
      }
    }
  }, [instance, nodes, layoutKey, definition.start]);
  useEffect(() => {
    let saved: Record<string, { x: number; y: number }> = {};
    try {
      saved = JSON.parse(localStorage.getItem(layoutKey) ?? '{}');
    } catch {
      /* Layout is optional. */
    }
    setNodes((current) =>
      initial.map(({ id, index, position }) => {
        const completed =
            view?.snapshot.steps.filter((s) => s.node === id) ?? [],
          latest = completed.at(-1);
        const currentNode = view?.snapshot.currentNode === id;
        const end = id.startsWith('end-');
        const kind = view?.execution?.structure.components[id]?.kind;
        const parallel = ['reviews', 'audits', 'decisions', 'batch'].includes(
          id,
        );
        const status = !view
          ? ''
          : end
            ? view.snapshot.outcome === id.slice(4)
              ? id === 'end-rejected'
                ? 'rejected'
                : 'succeeded'
              : 'pending'
            : currentNode && view.snapshot.status !== 'succeeded'
              ? view.snapshot.status
              : latest?.result.status === 'accepted'
                ? 'succeeded'
                : latest
                  ? 'failed'
                  : 'pending';
        const previous =
          initialized.current === layoutKey
            ? current.find((n) => n.id === id)?.position
            : undefined;
        return {
          id,
          type: 'task',
          position: previous ?? saved[id] ?? position,
          selected: selection?.kind === 'node' && selection.id === id,
          ariaLabel: `${end ? '结束' : '节点 ' + (index + 1)} ${nameOf(id)}${status ? ' · ' + (statusNames[status] ?? status) : ''}`,
          data: {
            label: nameOf(id),
            subtitle: end
              ? (outcomeNames[id.slice(4)] ?? id.slice(4))
              : definition.nodes[id].component,
            end,
            kind,
            parallel,
            status,
            count: completed.length,
            index,
          },
        };
      }),
    );
    initialized.current = layoutKey;
  }, [initial, layoutKey, view?.snapshot, selection]);
  const edges: Edge[] = useMemo(
    () =>
      definition.routes.map((r: any, i: number) => {
        const target = r.to.node ?? 'end-' + r.to.end;
        const sourcePosition = nodes.find((n) => n.id === r.from)?.position ?? {
          x: 0,
          y: 0,
        };
        const targetPosition = nodes.find((n) => n.id === target)?.position ?? {
          x: 0,
          y: 0,
        };
        const repair = !!r.limit;
        const taken = view?.snapshot.steps.some(
          (s) =>
            s.node === r.from &&
            s.result.status === 'accepted' &&
            s.result.outcome === r.outcome,
        );
        const selected =
          selection?.kind === 'edge' && selection.id === String(i);
        const incoming = view?.snapshot.steps.at(-1);
        const active =
          !!view &&
          view.snapshot.currentNode === target &&
          !terminal(view.snapshot.status) &&
          !!incoming &&
          incoming.node === r.from &&
          incoming.result.status === 'accepted' &&
          incoming.result.outcome === r.outcome;
        const color = selected
          ? '#2563eb'
          : repair
            ? taken
              ? '#d97706'
              : '#c1a681'
            : taken
              ? '#329176'
              : '#aeb8c7';
        return {
          id: String(i),
          source: r.from,
          target,
          ...routePorts(sourcePosition, targetPosition, repair),
          type: repair ? 'repair' : 'smoothstep',
          label:
            repair || selected || r.outcome !== 'completed'
              ? (outcomeNames[r.outcome] ?? r.outcome)
              : undefined,
          ariaLabel: `${nameOf(r.from)} → ${nameOf(target)}：${outcomeNames[r.outcome] ?? r.outcome}`,
          animated: !!active && !!taken,
          selected,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 18,
            height: 18,
          },
          style: {
            stroke: color,
            strokeWidth: selected ? 3 : taken ? 2.3 : 1.7,
            ...(repair ? { strokeDasharray: '6 5' } : {}),
          },
          labelStyle: { fill: '#536174', fontSize: 12, fontWeight: 500 },
          labelBgStyle: { fill: '#f5f7fb', fillOpacity: 1 },
          data: {
            lane:
              Math.min(...nodes.map((n) => n.position.x), 0) -
              46 -
              definition.routes.slice(0, i).filter((v: any) => v.limit).length *
                23,
            offset:
              26 +
              definition.routes.slice(0, i).filter((v: any) => v.limit).length *
                10,
          },
        };
      }),
    [definition, nodes, selection, view?.snapshot],
  );
  const changes = (updates: NodeChange[]) =>
    setNodes((current) => {
      const next = applyNodeChanges(updates, current);
      if (updates.some((u) => u.type === 'position' && !u.dragging)) {
        try {
          localStorage.setItem(
            layoutKey,
            JSON.stringify(
              Object.fromEntries(next.map((n) => [n.id, n.position])),
            ),
          );
        } catch {
          /* Browsing can continue without storage. */
        }
      }
      return next;
    });
  const focus = () => {
    const id =
      view?.snapshot.currentNode ??
      view?.snapshot.steps.at(-1)?.node ??
      definition.start;
    const node = nodes.find((n) => n.id === id);
    if (node) {
      onSelect({ kind: 'node', id });
      void instance?.setCenter(node.position.x + 118, node.position.y + 48, {
        zoom: 1,
        duration: 300,
      });
    }
  };
  const fit = () =>
    void instance?.fitView({
      padding: 0.12,
      minZoom: 0.1,
      maxZoom: 1,
      duration: 250,
    });
  return (
    <div className="graph" aria-label="工作流画布" ref={canvasElement}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={setInstance}
        onNodesChange={changes}
        onNodeClick={(event, n) => {
          onSelect({ kind: 'node', id: n.id });
          const element = (event.target as Element).closest(
            '.react-flow__node',
          );
          const graph = element?.closest('.graph')?.getBoundingClientRect();
          const rect = element?.getBoundingClientRect();
          if (
            graph &&
            rect &&
            graph.width > 850 &&
            rect.right > graph.right - 375
          )
            void instance?.setCenter(n.position.x + 118, n.position.y + 48, {
              zoom: instance.getZoom(),
              duration: 250,
            });
        }}
        onEdgeClick={(_e, edge) => onSelect({ kind: 'edge', id: edge.id })}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        minZoom={0.35}
        maxZoom={1.75}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.78, maxZoom: 1 }}
      >
        <Background gap={20} color="#d9dfe9" />
        <Controls showInteractive={false} showFitView={false} />
        {minimap && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              n.data.status === 'succeeded'
                ? '#329176'
                : n.data.status === 'failed'
                  ? '#db5c5c'
                  : '#ccd3df'
            }
          />
        )}
      </ReactFlow>
      <div className="canvas-tools">
        <button onClick={fit}>适应画布</button>
        <button
          onClick={() => {
            try {
              localStorage.removeItem(layoutKey);
            } catch {}
            setNodes((current) =>
              current.map((n) => ({
                ...n,
                position: initial.find((v) => v.id === n.id)!.position,
              })),
            );
            setTimeout(fit, 30);
          }}
        >
          自动布局
        </button>
        <button
          className={minimap ? 'active' : ''}
          aria-pressed={minimap}
          onClick={() => setMinimap((v) => !v)}
        >
          缩略图
        </button>
        {view && (
          <button className="focus-current" onClick={focus}>
            定位{terminal(view.snapshot.status) ? '最后' : '当前'}步骤
          </button>
        )}
      </div>
      {view && (
        <div className="canvas-legend">
          <span>
            <i className="done" />
            已完成
          </span>
          <span>
            <i className="active" />
            当前
          </span>
          <span>
            <i />
            未执行
          </span>
        </div>
      )}
    </div>
  );
}
