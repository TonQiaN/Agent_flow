import type { RunnerLaunchState } from './types.js';

/** One launch sequence for a newly allocated resource. Failed/unknown calls never advance it. */
export const runnerLaunchStates: readonly RunnerLaunchState[] = Object.freeze([
  'allocated', 'prepare_pending', 'prepare_completed', 'create_pending', 'create_completed', 'start_pending', 'start_completed',
]);
