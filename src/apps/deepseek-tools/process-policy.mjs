// A process-local, non-JSON capability. Only the trusted Bash mapping grants task writes.
const policyKey = Symbol('agentflow-tool-policy');
export function withToolPolicy(spec, mode) {
  if (mode !== 'read-only' && mode !== 'workspace-write') throw new Error('UNSUPPORTED_TOOL_POLICY');
  return { ...spec, [policyKey]: mode };
}
export function toolPolicy(spec) { return spec[policyKey] ?? 'read-only'; }
