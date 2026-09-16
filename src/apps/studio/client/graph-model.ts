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
  match: '匹配与推荐',
  audit: '独立复核',
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
  updated: '修订完成',
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
  const main = primaryPath(definition);
  const positions = new Map(
    main.map((id, column) => [id, { x: column * 420, y: 0 }]),
  );
  const occupied = new Set(main.map((_, column) => `${column}:0`));
  const placeBranch = (id: string, column: number) => {
    let row = 1;
    while (occupied.has(`${column}:${row}`)) row++;
    occupied.add(`${column}:${row}`);
    positions.set(id, { x: column * 420, y: row * 210 });
  };
  for (const id of order.filter((node) => !positions.has(node))) {
    const incoming = definition.routes.find(
      (r) => r.to.node === id && positions.has(r.from),
    );
    placeBranch(
      id,
      incoming ? positions.get(incoming.from)!.x / 420 + 1 : 0,
    );
  }
  const ends = [
    ...new Set(
      definition.routes.flatMap((r) => (r.to.end ? [r.to.end] : [])),
    ),
  ].sort((a, b) => Number(a === 'rejected') - Number(b === 'rejected'));
  for (const end of ends) {
    const incoming = definition.routes.filter((r) => r.to.end === end);
    const column = Math.max(
      0,
      ...incoming.map((r) => (positions.get(r.from)?.x ?? 0) / 420 + 1),
    );
    if (
      incoming.some((r) => r.from === main.at(-1)) &&
      !occupied.has(`${column}:0`)
    ) {
      positions.set('end-' + end, { x: column * 420, y: 0 });
      occupied.add(`${column}:0`);
    } else placeBranch('end-' + end, column);
  }
  return [...order, ...ends.map((id) => 'end-' + id)].map((id, index) => ({
    id,
    index,
    position: positions.get(id)!,
  }));
}

// Explain the existing route, without inferring additional execution rules.
const recruitmentRoutes: Record<string, string> = {
  'parse:completed:match': '全部材料 → 匹配分析',
  'match:completed:audit': '逐项证据与推荐 → 复核',
  'audit:passed:render': '复核通过 → 生成报告',
  'audit:revise:match': '分析或引用有误 → 修订',
  'audit:rejected:end-rejected': '复核仍未通过 → 结束',
  'parse:completed:requirements': '材料文本 → 岗位拆解',
  'requirements:completed:prepare-reviews': '岗位要求 → 分配评审',
  'prepare-reviews:completed:reviews': '候选人 × 四个维度',
  'reviews:completed:collect-reviews': '评审完成 → 汇总证据',
  'collect-reviews:completed:prepare-audits': '逐项证据 → 独立复核',
  'prepare-audits:completed:audits': '按候选人并行复核',
  'audits:completed:collect-audits': '复核完成 → 汇总发现',
  'collect-audits:completed:evidence-gate': '证据与发现 → 校验',
  'evidence-gate:passed:prepare-decisions': '证据通过 → 准备判断',
  'evidence-gate:revise:prepare-reviews': '证据需修订 → 重新评审',
  'evidence-gate:revise-job:requirements': '岗位有问题 → 重新拆解',
  'evidence-gate:rejected:end-rejected': '校验未通过 → 结束',
  'prepare-decisions:completed:decisions': '按候选人形成推荐',
  'decisions:completed:collect-decisions': '二元推荐 → 汇总结论',
  'collect-decisions:completed:delivery-gate': '全部结论 → 交付检查',
  'delivery-gate:passed:render': '交付通过 → 生成报告',
  'delivery-gate:revise:prepare-decisions': '结论需修订 → 重新判断',
  'render:completed:end-completed': '报告与 PDF → 完成',
};
export function routeLabel(
  definition: FlowDefinition,
  route: FlowDefinition['routes'][number],
) {
  const target = route.to.node ?? 'end-' + route.to.end;
  const specific =
    definition.id === 'recruitment'
      ? recruitmentRoutes[`${route.from}:${route.outcome}:${target}`]
      : undefined;
  const generic = `${outcomeNames[route.outcome] ?? route.outcome} → ${route.to.end ? '结束' : route.limit || ['updated', 'repaired'].includes(route.outcome) ? nameOf(target) : '继续'}`;
  return (
    (specific ?? generic) +
    (route.limit ? ` · 最多 ${route.limit.max} 次` : '')
  );
}
export function routePorts(
  source: { x: number; y: number },
  target: { x: number; y: number },
  returning: boolean,
) {
  if (returning) return { sourceHandle: 'top-out', targetHandle: 'top-in' };
  if (target.x < source.x && target.y < source.y)
    return { sourceHandle: 'left-out', targetHandle: 'bottom-in' };
  if (target.y > source.y && Math.abs(target.x - source.x) < 20)
    return { sourceHandle: 'bottom-out', targetHandle: 'top-in' };
  if (target.y < source.y && Math.abs(target.x - source.x) < 20)
    return { sourceHandle: 'top-out', targetHandle: 'bottom-in' };
  return target.x >= source.x
    ? { sourceHandle: 'right-out', targetHandle: 'left-in' }
    : { sourceHandle: 'left-out', targetHandle: 'right-in' };
}
