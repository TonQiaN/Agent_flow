import { setTimeout } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { Clock } from '@agentflow/engine';

// Epoch-based timestamps with monotonic elapsed time even when the wall clock is adjusted.
export const systemClock: Clock = { now: () => performance.timeOrigin + performance.now(), sleep: async ms => { await setTimeout(ms); } };
