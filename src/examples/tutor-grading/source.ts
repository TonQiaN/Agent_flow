import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { canonicalJson, DefinitionError, snapshotJson } from '@agentflow/engine';
import type { ArtifactArchive, ArtifactArchiveReference, RunRecordStore } from '@agentflow/engine';
import type { FileWorkflowCatalog } from '@agentflow/integrations';
import { gradingSourceFacts } from './file-scripts.js';
import type { GradingSourceFacts } from './gate.js';

/** Capture once; normal startPersisted archives this input before creating its Run row. */
export async function prepareGradingSource(files: FileWorkflowCatalog, runId: string, source: string): Promise<{ input: JsonValue; source: GradingSourceFacts }> {
  const input = await files.prepareInput(runId, source, 'source-files');
  try { return { input, source: gradingSourceFacts(files.inspect(input, runId).manifest) }; }
  catch (error) { await files.release(input, runId); throw error; }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value: unknown, fields: string[]): value is Record<string, unknown> => object(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const equal = (a: unknown, b: unknown): boolean => canonicalJson(snapshotJson(a)) === canonicalJson(snapshotJson(b));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function valid(value: unknown): asserts value { if (!value) throw new DefinitionError('INVALID_GRADING_SOURCE_CHECKPOINT'); }

/** Read only the source metadata needed to install current code before full checkpoint loading.
 * This does not validate execution history/file bytes, restore tokens, or authorize recovery. */
export async function readGradingSource(runId: string, records: Pick<RunRecordStore, 'read'>, archive: Pick<ArtifactArchive, 'read'>): Promise<GradingSourceFacts> {
  valid(isIdentifier(runId));
  const record = await records.read(runId);
  if (record === null) throw new DefinitionError('GRADING_RUN_NOT_FOUND');
  valid(record.runId === runId && Number.isSafeInteger(record.revision) && record.revision >= 1);
  let checkpoint: unknown = snapshotJson(record.content);
  if (object(checkpoint) && checkpoint['schema'] === 'agentflow-workflow-recovery/v1') {
    valid(shape(checkpoint, ['schema', 'checkpoint', 'claimRevision', 'resourceRemoved'])
      && typeof checkpoint['claimRevision'] === 'number' && Number.isSafeInteger(checkpoint['claimRevision'])
      && checkpoint['claimRevision'] >= 2 && checkpoint['claimRevision'] <= record.revision && typeof checkpoint['resourceRemoved'] === 'boolean');
    checkpoint = checkpoint['checkpoint'];
  }
  valid(shape(checkpoint, ['schema', 'execution', 'snapshot', 'cursor', 'values', 'attempts'])
    && checkpoint['schema'] === 'agentflow-workflow-checkpoint/v5' && object(checkpoint['snapshot']) && checkpoint['snapshot']['runId'] === runId
    && object(checkpoint['execution']) && checkpoint['execution']['version'] === 2 && object(checkpoint['execution']['structure']));
  const structure = checkpoint['execution']['structure'];
  valid(structure['version'] === 1 && object(structure['workflow']) && isIdentifier(structure['workflow']['start'])
    && equal(structure['workflow']['input'], { kind: 'files', id: 'source-files' }));
  valid(Array.isArray(checkpoint['values']) && checkpoint['values'].length > 0);
  const input = checkpoint['values'][0];
  valid(shape(input, ['node', 'contract', 'value', 'saved']) && input['node'] === structure['workflow']['start']
    && equal(input['contract'], structure['workflow']['input']) && shape(input['value'], ['fileRef']) && uuid(input['value']['fileRef']));
  const saved = input['saved'];
  valid(shape(saved, ['schema', 'runId', 'value', 'manifest', 'archive', 'receipt']) && saved['schema'] === 'agentflow-workflow-files/v1'
    && saved['runId'] === runId && saved['receipt'] === null && equal(saved['value'], input['value'])
    && object(saved['manifest']) && uuid(saved['manifest']['id']) && saved['manifest']['contractId'] === 'source-files'
    && shape(saved['archive'], ['id', 'sha256']) && uuid(saved['archive']['id'])
    && typeof saved['archive']['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(saved['archive']['sha256']));
  const manifest = await archive.read(snapshotJson(saved['archive']) as unknown as ArtifactArchiveReference);
  if (manifest.id !== saved['archive']['id'] || manifest.contractId !== 'source-files'
    || !equal(saved['manifest'], { ...manifest, id: saved['manifest']['id'] })) throw new DefinitionError('GRADING_SOURCE_ARCHIVE_MISMATCH');
  return gradingSourceFacts(manifest);
}
