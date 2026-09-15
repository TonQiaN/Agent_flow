import type { RunView } from '@agentflow/integrations';
export type { RunView };
export interface Workflow {
  id: string;
  title: string;
  description: string;
  entrypoint: string;
  input: string;
  requires: string[];
  missing: string[];
  definition: any;
}
export interface Catalogue {
  workflows: Workflow[];
  settings: any;
  retention: string;
}
export interface RunDetail {
  meta: any;
  runs: { key: string; view: RunView }[];
  completion: any;
}
export interface Artifact {
  id: string;
  name: string;
  bytes: number;
  mediaType: string;
  sha256: string;
  accepted: boolean;
  runId: string;
  nodeTaskId?: string;
  sequence?: number;
  unavailable?: string;
}
export async function api<T>(path: string): Promise<T> {
  const response = await fetch('/api/' + path).catch(() => {
    throw new Error('暂时连不上本机服务，请确认服务已启动，再点击重新连接。');
  });
  const value = await response.json().catch(() => {
    throw new Error('本机服务返回的数据无法读取，请检查服务状态。');
  });
  if (!response.ok) throw new Error(value.error ?? '本机服务连接失败');
  return value;
}
export const pretty = (v: unknown) => JSON.stringify(v, null, 2) ?? '没有保存';
export const date = (time: number | null | undefined) =>
  time
    ? new Date(time).toLocaleString('zh-CN', { hour12: false })
    : '时间未记录';
export const statusNames: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  parallel_wait: '等待并行任务',
  retry_wait: '等待重试',
  cancelling: '取消中',
  cancelled: '已取消',
  succeeded: '已完成',
  failed: '执行失败',
  exhausted: '次数已用尽',
  interrupted: '进程已中断',
  unavailable: '记录不可用',
  accepted: '节点已通过',
};
export const terminal = (status: string) =>
  [
    'succeeded',
    'failed',
    'cancelled',
    'exhausted',
    'interrupted',
    'unavailable',
  ].includes(status);
export function navigate(path: string) {
  window.location.hash = path;
}
