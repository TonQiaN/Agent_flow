export interface FlowDefinition {
  id?: string;
  start: string;
  nodes: Record<string, { component: string }>;
  routes: {
    from: string;
    outcome: string;
    to: { node?: string; end?: string };
    limit?: { max: number; exhausted: { end: string } };
  }[];
}

export const nodeNames: Record<string, string> = {
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
export const outcomeNames: Record<string, string> = {
  completed: '完成',
  passed: '通过',
  accepted: '通过',
  revise: '返工',
  'revise-job': '重查岗位',
  rejected: '未通过',
  repaired: '修订完成',
  published: '已发布',
  valid: '通过',
  invalid: '需修订',
};
export const nameOf = (id: string) =>
  nodeNames[id] ??
  (id.startsWith('end-')
    ? id === 'end-rejected'
      ? '校验未通过'
      : '流程完成'
    : id);

export function primaryPath(definition: FlowDefinition): string[] {
  const path: string[] = [];
  let id: string | undefined = definition.start;
  while (id && definition.nodes[id] && !path.includes(id)) {
    path.push(id);
    const choices = definition.routes.filter(
      (r) => r.from === id && !r.limit && r.outcome !== 'rejected',
    );
    const next =
      choices.find((r) =>
        ['completed', 'passed', 'accepted'].includes(r.outcome),
      ) ?? choices[0];
    id = next?.to.node;
  }
  return path;
}

/** Follow real routes from start, preferring the forward success path over bounded repairs. */
export function flowOrder(definition: FlowDefinition): string[] {
  const result: string[] = [],
    seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !definition.nodes[id]) return;
    seen.add(id);
    result.push(id);
    const next = definition.routes.filter(
      (r) => r.from === id && r.to.node && !r.limit,
    );
    next.sort(
      (a, b) =>
        Number(!['completed', 'passed', 'accepted'].includes(a.outcome)) -
        Number(!['completed', 'passed', 'accepted'].includes(b.outcome)),
    );
    next.forEach((r) => visit(r.to.node!));
  };
  visit(definition.start);
  Object.keys(definition.nodes).forEach(visit);
  return result;
}

export function graphLayout(definition: FlowDefinition) {
  const order = flowOrder(definition);
  const ends = [
    ...new Set(definition.routes.flatMap((r) => (r.to.end ? [r.to.end] : []))),
  ].sort((a, b) => Number(a === 'rejected') - Number(b === 'rejected'));
  return [...order, ...ends.map((id) => 'end-' + id)].map((id, index) => {
    const row = Math.floor(index / 4),
      column = index % 4;
    return {
      id,
      index,
      position: { x: (row % 2 ? 3 - column : column) * 304, y: row * 156 },
    };
  });
}
export function routePorts(
  source: { x: number; y: number },
  target: { x: number; y: number },
  repair: boolean,
) {
  if (repair) return { sourceHandle: 'top-out', targetHandle: 'top-in' };
  if (target.y > source.y && Math.abs(target.x - source.x) < 20)
    return { sourceHandle: 'bottom-out', targetHandle: 'top-in' };
  if (target.y < source.y && Math.abs(target.x - source.x) < 20)
    return { sourceHandle: 'top-out', targetHandle: 'bottom-in' };
  return target.x >= source.x
    ? { sourceHandle: 'right-out', targetHandle: 'left-in' }
    : { sourceHandle: 'left-out', targetHandle: 'right-in' };
}
