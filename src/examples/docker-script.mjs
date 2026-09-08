import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '@agentflow/engine';
import { DockerBackend, systemClock } from '@agentflow/integrations';

const root = await mkdtemp(join(tmpdir(), 'agentflow-example-'));
const source = join(root, 'source');
await mkdir(source);
await writeFile(join(source, 'answer.txt'), 'original');
const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: process.env.AGENTFLOW_TEST_IMAGE ?? 'alpine:3' });
const runner = new Runner(backend, systemClock);
const result = await runner.run({
  identity: { runId: 'example', nodeTaskId: 'edit-input', attemptId: 'attempt-1', attemptNumber: 1 },
  inputSource: source, timeoutMs: 15_000,
  invocation: { argv: ['/bin/sh', '-c', 'echo edited > /task/input/answer.txt; cp /task/input/answer.txt /task/outputs/answer.txt'] },
});
if (result.phase === 'exited' && result.exitCode === 0 && result.capture && result.cleanup === 'removed') {
  const output = await readFile(join(result.capture.outputsPath, 'answer.txt'), 'utf8');
  const original = await readFile(join(source, 'answer.txt'), 'utf8');
  console.log(JSON.stringify({ phase: result.phase, exitCode: result.exitCode, original, output, imageId: result.capture.imageId }));
  await runner.release(result.resource);
  await rm(root, { recursive: true, force: true });
} else {
  console.error(JSON.stringify(result));
  // Retain failed resources for diagnosis; do not delete an unconfirmed running workspace.
  process.exitCode = 1;
}
