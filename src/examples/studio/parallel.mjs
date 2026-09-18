/** Shared with the original CLI and the read-only catalogue. */
export function parallelDefinition(kind) {
  if (!['map', 'fork'].includes(kind)) throw new Error('Use map or fork');
  return {
    id: 'demo',
    start: 'batch',
    maxSteps: 1,
    input: { kind: 'json', id: kind === 'map' ? 'items' : 'item' },
    outcomes: { done: { kind: 'json', id: 'joined' } },
    nodes: { batch: { component: 'batch' } },
    routes: [{ from: 'batch', outcome: 'done', to: { end: 'done' } }],
  };
}
