import { isAbsolute } from 'node:path';
import { rm } from 'node:fs/promises';
import { ArtifactError, FileContractRegistry } from '@agentflow/engine';
import type { ArtifactMaterializer, ArtifactStore, FileManifest } from '@agentflow/engine';
import { captureSnapshot, materializeSnapshot } from './snapshot-io.js';
import type { StoredSnapshot } from './snapshot-io.js';
export { ArtifactError } from '@agentflow/engine';

/** Host-owned, process-local snapshots. Call only after all source writers have stopped. */
export class FileArtifactStore implements ArtifactStore {
  readonly #snapshots = new Map<string, StoredSnapshot>();
  constructor(readonly root: string, readonly contracts: FileContractRegistry) {
    if (!isAbsolute(root)) throw new ArtifactError('INVALID_STORE_ROOT');
  }
  async capture(source: string, contractId: string): Promise<FileManifest> {
    const snapshot = await captureSnapshot(this.root, this.contracts, source, contractId);
    this.#snapshots.set(snapshot.manifest.id, snapshot);
    return structuredClone(snapshot.manifest);
  }
  async captureMaterialized(source: ArtifactMaterializer, contractId: string): Promise<FileManifest> {
    const snapshot = await captureSnapshot(this.root, this.contracts, source, contractId);
    this.#snapshots.set(snapshot.manifest.id, snapshot);
    return structuredClone(snapshot.manifest);
  }
  async inspect(id: string): Promise<FileManifest> {
    const snapshot = this.#snapshots.get(id); if (!snapshot) throw new ArtifactError('UNKNOWN_SNAPSHOT');
    return structuredClone(snapshot.manifest);
  }
  async materialize(id: string, destination: string): Promise<void> {
    const snapshot = this.#snapshots.get(id); if (!snapshot) throw new ArtifactError('UNKNOWN_SNAPSHOT');
    await materializeSnapshot(this.root, snapshot, destination);
  }
  async release(id: string): Promise<void> {
    const snapshot = this.#snapshots.get(id); if (!snapshot) return;
    await rm(snapshot.cleanupRoot ?? snapshot.root, { recursive: true, force: true }); this.#snapshots.delete(id);
  }
}
