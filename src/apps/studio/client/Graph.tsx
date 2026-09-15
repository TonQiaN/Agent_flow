import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  type NodeProps,
  type NodeChange,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { RunView } from './api';
export const labels: Record<string, string> = {
  parse: '读取全部材料',
  requirements: '拆解岗位要求',
  'prepare-reviews': '分配评审任务',
  reviews: '四维并行评审',
  'collect-reviews': '汇总逐项证据',
  'prepare-audits': '分配独立复核',
  audits: '独立复核',
  'collect-audits': '汇总复核发现',
  'evidence-gate': '检查证据与归属',
  'prepare-decisions': '准备最终判断',
  decisions: '形成二元推荐',
  'collect-decisions': '汇总候选人结论',
  'delivery-gate': '检查交付结果',
  render: '生成报告与 PDF',
  review: '检查草稿',
  repair: '修订与返工',
  batch: '并行任务组',
  intake: '接收材料',
  marker: '执行批改',
  gate: '检查结果',
  fixer: '修订批改',
  projection: '准备发布数据',
  publish: '模拟发布',
  unit: '执行子任务',
  candidateGate: '检查批改候选',
  reviewer: '独立复核',
  finalGate: '最终检查',
  reporter: '生成报告',
  prepare: '准备报告材料',
};
export type Selection = { kind: 'node' | 'edge'; id: string } | null;
function TaskNode({ data, selected }: NodeProps) {
  return (
    <div
      className={`task-node ${data.status ?? ''} ${selected ? 'selected' : ''} ${data.end ? 'end' : ''}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="node-top">
        <span className="node-icon">
          {data.end
            ? data.status === 'succeeded'
              ? '✓'
              : '○'
            : data.kind === 'agent'
              ? '✦'
              : data.kind === 'gate'
                ? '◇'
                : '▦'}
        </span>
        <span>{String(data.label)}</span>
        <i className="state-dot" />
      </div>
      <div className="node-sub">
        {String(data.subtitle)}{' '}
        {Number(data.count) > 1 && <b>× {String(data.count)}</b>}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const nodeTypes = { task: TaskNode };
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
  const [nodes, setNodes] = useState<Node[]>([]);
  const edges: Edge[] = useMemo(
    () =>
      (definition.routes ?? []).map((r: any, i: number) => ({
        id: String(i),
        source: r.from,
        target: r.to.node ?? 'end-' + r.to.end,
        label: r.outcome,
        type: 'smoothstep',
        animated:
          view?.snapshot.currentNode === r.from &&
          view?.snapshot.status === 'running',
        style: {
          stroke: r.limit ? '#b67435' : '#9bafae',
          strokeWidth:
            selection?.kind === 'edge' && selection.id === String(i) ? 3 : 1.5,
        },
        labelStyle: { fill: r.limit ? '#905420' : '#49676a', fontSize: 10 },
        labelBgStyle: { fill: '#f6f8f5', fillOpacity: 0.95 },
        selected: selection?.kind === 'edge' && selection.id === String(i),
      })),
    [definition, selection, view?.snapshot],
  );
  useEffect(() => {
    const keys = Object.keys(definition.nodes ?? {}),
      ends = [
        ...new Set(
          (definition.routes ?? [])
            .filter((r: any) => r.to.end)
            .map((r: any) => r.to.end),
        ),
      ] as string[];
    let saved: Record<string, { x: number; y: number }> = {};
    try {
      saved = JSON.parse(localStorage.getItem('layout:' + storageKey) ?? '{}');
    } catch {}
    setNodes(
      [...keys, ...ends.map((e) => 'end-' + e)].map((id, i) => {
        const completed =
            view?.snapshot.steps.filter((s) => s.node === id) ?? [],
          latest = completed.at(-1),
          active = view?.snapshot.currentNode === id;
        return {
          id,
          type: 'task',
          position: saved[id] ?? {
            x: (i % 4) * 218 + 15,
            y: Math.floor(i / 4) * 155 + 35,
          },
          selected: selection?.kind === 'node' && selection.id === id,
          data: {
            label:
              labels[id] ??
              (id.startsWith('end-')
                ? id === 'end-rejected'
                  ? '结果未通过'
                  : '流程结束'
                : id),
            subtitle: id.startsWith('end-')
              ? id.slice(4)
              : definition.nodes[id].component,
            end: id.startsWith('end-'),
            kind: view?.execution?.structure.components[id]?.kind,
            status:
              id.startsWith('end-') && view?.snapshot.outcome === id.slice(4)
                ? 'succeeded'
                : active
                  ? view!.snapshot.status
                  : latest?.result.status === 'accepted'
                    ? 'succeeded'
                    : latest
                      ? 'failed'
                      : '',
            count: completed.length,
          },
        };
      }),
    );
  }, [definition, view?.snapshot, storageKey, selection]);
  const changes = (updates: NodeChange[]) =>
    setNodes((current) => {
      const next = applyNodeChanges(updates, current);
      if (updates.some((u) => u.type === 'position' && !u.dragging))
        try {
          localStorage.setItem(
            'layout:' + storageKey,
            JSON.stringify(
              Object.fromEntries(next.map((n) => [n.id, n.position])),
            ),
          );
        } catch {}
      return next;
    });
  return (
    <div className="graph" aria-label="工作流画布">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={changes}
        onNodeClick={(_e, n) => onSelect({ kind: 'node', id: n.id })}
        onEdgeClick={(_e, edge) => onSelect({ kind: 'edge', id: edge.id })}
        onPaneClick={() => onSelect(null)}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        minZoom={0.3}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.15 }}
      >
        <Background gap={18} color="#d3ded8" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            n.data.status === 'succeeded'
              ? '#439386'
              : n.data.status === 'failed'
                ? '#c06651'
                : '#d4ddd8'
          }
        />
      </ReactFlow>
      <div className="canvas-hint">拖动调整位置 · 点击节点或连线查看详情</div>
    </div>
  );
}
