import type { FileManifest } from '../contracts/files.js';

/** Persist this reference with the Run only after capture has returned successfully. */
export interface ArtifactArchiveReference { readonly id: string; readonly sha256: string }
export interface ArchivedArtifact { readonly reference: ArtifactArchiveReference; readonly manifest: FileManifest }
/** Run retention is independent of temporary execution handles. No release/delete operation. */
export interface ArtifactArchive {
  capture(source: string, contractId: string): Promise<ArchivedArtifact>;
  read(reference: ArtifactArchiveReference): Promise<FileManifest>;
  materialize(reference: ArtifactArchiveReference, destination: string): Promise<void>;
}
