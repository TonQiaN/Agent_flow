import { join } from 'node:path';
import { createGradingApplication, gradingComponent, gradingWorkflow } from './flow.js';
import type { GradingAgentBinding, GradingPublication } from './flow.js';
import { GradingFixtureDriver, fixtureRoot } from './fixture-driver.js';
import type { FixtureMode } from './fixture-driver.js';

export interface GradingOptions extends GradingPublication { readonly marker?: FixtureMode; readonly fixer?: 'correct' | 'stuck'; readonly repairs?: number; readonly maxSteps?: number }
export const gradingFixturePrompts = {
  marker: 'Grade the submitted answers against the supplied paper and answer key. Put candidate.json and the source bundle in outputs.',
  fixer: 'Read gate-report.json and repair the grading candidate. Put the corrected bundle in outputs.',
};
export const gradingDefinition = (options: GradingOptions = {}) => gradingWorkflow({ id: 'fixture-grading', marker: `marker-${options.marker ?? 'wrong'}`, fixer: `fixer-${options.fixer ?? 'correct'}`,
  ...(options.repairs === undefined ? {} : { repairs: options.repairs }), ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }) });
export async function createGradingFixture(root: string, options: GradingOptions = {}) {
  const agents: GradingAgentBinding[] = [];
  for (const mode of ['correct', 'wrong', 'malformed', 'source-tamper', 'bad-evidence', 'stuck'] as const) agents.push({
    component: gradingComponent(`marker-${mode}`, 'agent', 'source-files', { completed: 'candidate-files' }), config: { mode },
    prompt: gradingFixturePrompts.marker,
  });
  for (const mode of ['correct', 'stuck'] as const) agents.push({
    component: gradingComponent(`fixer-${mode}`, 'agent', 'reviewed-files', { completed: 'candidate-files' }), config: { mode },
    prompt: gradingFixturePrompts.fixer,
  });
  return createGradingApplication(root, { source: join(fixtureRoot, 'source'), driver: artifacts => new GradingFixtureDriver(artifacts, join(root, 'agents')), agents,
    definition: gradingDefinition(options) }, options);
}
