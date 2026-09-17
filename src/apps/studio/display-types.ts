import type { ExecutionIdentity } from '@agentflow/domain';
export interface AttemptTiming {
  node: string; identity: ExecutionIdentity;
  startedAt: number | null; finishedAt: number | null; ended: boolean;
  execution: { startedAt: number; finishedAt: number }[];
}
export interface RunTimeline {
  startedAt: number | null; finishedAt: number | null; updatedAt: number | null;
  attempts: AttemptTiming[];
  revisions: { sequence: number; revision: number; recordedAt: number | null; node: string | null; status: string }[];
}
export interface FileSource {
  runId: string; node?: string; nodeTaskId?: string; attemptId?: string; attemptNumber?: number;
  role: 'input' | 'output' | 'draft' | 'unassigned'; recordedAt?: number;
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
  sources?: FileSource[];
}
