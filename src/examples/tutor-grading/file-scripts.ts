import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { SCRIPT_RESULT_SCHEMA, TASK_PATHS } from '@agentflow/engine';
import type { ScriptDefinition } from '@agentflow/engine';
import { sourcePaths } from './gate.js';
import type { GradingSourceFacts } from './gate.js';

export interface GradingFileScripts {
  readonly source: GradingSourceFacts;
  readonly intake: Pick<ScriptDefinition, 'argv' | 'timeoutMs'>;
  readonly gate: Pick<ScriptDefinition, 'argv' | 'timeoutMs'>;
}

/** Application-owned source evidence, not data selected by an agent's writable input. */
export function gradingSourceFacts(original: GradingSourceFacts): GradingSourceFacts {
  if (!original || !Array.isArray(original.files) || original.files.length !== sourcePaths.length) throw new Error('INVALID_GRADING_SOURCE_FACTS');
  return { files: sourcePaths.map(path => {
    const matching = original.files.filter(file => file?.path === path);
    if (matching.length !== 1 || typeof matching[0]!.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(matching[0]!.sha256)) throw new Error('INVALID_GRADING_SOURCE_FACTS');
    return { path, sha256: matching[0]!.sha256 };
  }) };
}

/** Actual installed program bytes become argv in the normal Script execution snapshot.
 * Rebuild from the current installation on recovery; never execute a saved program blindly. */
export async function gradingFileScripts(original: GradingSourceFacts): Promise<GradingFileScripts> {
  const source = gradingSourceFacts(original), sourceArgument = JSON.stringify(source);
  const program = stripTypeScriptTypes(await readFile(new URL('./gate.ts', import.meta.url), 'utf8'));
  const intake = `import { cp } from 'node:fs/promises';
await cp(${JSON.stringify(TASK_PATHS.input)}, ${JSON.stringify(TASK_PATHS.outputs)}, { recursive: true });
process.stdout.write(JSON.stringify({schema:${JSON.stringify(SCRIPT_RESULT_SCHEMA)},outcome:'completed'}));`;
  const gate = `${program}
const result = await review({inputPath:${JSON.stringify(TASK_PATHS.input)},outputsPath:${JSON.stringify(TASK_PATHS.outputs)}}, JSON.parse(process.argv[1]));
process.stdout.write(JSON.stringify({schema:${JSON.stringify(SCRIPT_RESULT_SCHEMA)},outcome:result.outcome}));`;
  return { source, intake: { argv: ['node', '--input-type=module', '-e', intake], timeoutMs: 30_000 },
    gate: { argv: ['node', '--input-type=module', '-e', gate, sourceArgument], timeoutMs: 30_000 } };
}
