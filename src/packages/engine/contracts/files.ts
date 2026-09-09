import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import { ContractRegistry } from './registry.js';

export interface FileRule {
  readonly id: string;
  readonly kind: 'file' | 'tree';
  readonly match: string;
  readonly minCount: number;
  readonly maxCount: number;
  readonly mediaTypes: readonly string[];
  readonly maxBytes: number;
  readonly jsonContract?: string;
  readonly minFiles?: number;
  readonly maxFiles?: number;
}
export interface FileContract {
  readonly rules: readonly FileRule[];
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly unmatched: 'reject';
}
export type FileEntry = { readonly path: string; readonly kind: 'directory' }
  | { readonly path: string; readonly kind: 'file'; readonly bytes: number; readonly mediaType: string; readonly json?: JsonValue };
export interface FileIssue { readonly path: string; readonly rule: string; readonly code: string }
export class ArtifactError extends Error {
  constructor(readonly code: string, readonly path = '', readonly issues: readonly FileIssue[] = []) { super(code); }
}
export interface FileManifest {
  readonly id: string;
  readonly contractId: string;
  readonly directories: readonly string[];
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string; readonly mediaType: string; readonly rule: string }[];
}
/** Execution coordination owns termination checks; the storage adapter owns source/destination IO. */
export interface ArtifactStore {
  capture(source: string, contractId: string): Promise<FileManifest>;
  materialize(id: string, destination: string): Promise<void>;
  release(id: string): Promise<void>;
}
export type FileCheck = { readonly valid: true; readonly assignments: readonly { readonly path: string; readonly rule: string }[]; readonly directories: readonly string[] }
  | { readonly valid: false; readonly issues: readonly FileIssue[] };

export function isArtifactPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\x00-\x1f\x7f:]/.test(value)
    && value.split('/').length <= 32 && value.split('/').every(part => part.length > 0 && part.length <= 255 && part !== '.' && part !== '..');
}
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v: object, keys: string[]): boolean => Object.keys(v).every(key => keys.includes(key));

// Bounded dynamic programming avoids regex backtracking for user-defined globs.
function segment(pattern: string, value: string): boolean {
  let row = Array<boolean>(value.length + 1).fill(false); row[0] = true;
  for (const character of pattern) {
    const next = Array<boolean>(value.length + 1).fill(false); next[0] = character === '*' && row[0]!;
    for (let i = 1; i <= value.length; i++) next[i] = character === '*' ? row[i]! || next[i - 1]! : row[i - 1]! && (character === '?' || character === value[i - 1]);
    row = next;
  }
  return row[value.length]!;
}
function matches(pattern: string, path: string): boolean {
  const parts = path.split('/'); let row = Array<boolean>(parts.length + 1).fill(false); row[0] = true;
  for (const part of pattern.split('/')) {
    const next = Array<boolean>(parts.length + 1).fill(false); next[0] = part === '**' && row[0]!;
    for (let i = 1; i <= parts.length; i++) next[i] = part === '**' ? row[i]! || next[i - 1]! : row[i - 1]! && segment(part, parts[i - 1]!);
    row = next;
  }
  return row[parts.length]!;
}

/** Pure contract validation. Filesystem facts must come from a trusted capture adapter. */
export class FileContractRegistry {
  readonly #contracts = new Map<string, FileContract>();
  constructor(readonly json: ContractRegistry) {}

  register(id: string, definition: unknown): void {
    if (!isIdentifier(id)) throw new DefinitionError('INVALID_FILE_CONTRACT_ID');
    if (this.#contracts.has(id)) throw new DefinitionError('DUPLICATE_FILE_CONTRACT');
    try {
      const value = copyJson(definition);
      if (!object(value) || !only(value, ['rules', 'maxFiles', 'maxTotalBytes', 'unmatched']) || value['unmatched'] !== 'reject'
        || !count(value['maxFiles']) || !count(value['maxTotalBytes']) || !Array.isArray(value['rules']) || value['rules'].length > 128) throw new Error();
      const ids = new Set<string>();
      for (const r of value['rules']) {
        if (!object(r) || !only(r, ['id', 'kind', 'match', 'minCount', 'maxCount', 'mediaTypes', 'maxBytes', 'jsonContract', 'minFiles', 'maxFiles'])
          || !isIdentifier(r['id']) || ids.has(r['id']) || !['file', 'tree'].includes(String(r['kind'])) || !isArtifactPath(r['match'])
          || /[\[\]{}!]/.test(r['match']) || r['match'].split('/').some(p => p.includes('**') && p !== '**')
          || !count(r['minCount']) || !count(r['maxCount']) || r['minCount'] > r['maxCount'] || !count(r['maxBytes'])
          || !Array.isArray(r['mediaTypes']) || !r['mediaTypes'].length || !r['mediaTypes'].every(m => typeof m === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m))) throw new Error();
        if (r['jsonContract'] !== undefined && (!isIdentifier(r['jsonContract']) || !this.json.has(r['jsonContract']) || !r['mediaTypes'].includes('application/json'))) throw new Error();
        if (r['kind'] === 'tree' ? !count(r['minFiles']) || !count(r['maxFiles']) || r['minFiles'] > r['maxFiles']
          : r['minFiles'] !== undefined || r['maxFiles'] !== undefined) throw new Error();
        ids.add(r['id']);
      }
      this.#contracts.set(id, value as unknown as FileContract);
    } catch { throw new DefinitionError('INVALID_FILE_CONTRACT'); }
  }

  definition(id: string): FileContract {
    const value = this.#contracts.get(id); if (!value) throw new DefinitionError('UNKNOWN_FILE_CONTRACT');
    return copyJson(value) as unknown as FileContract;
  }

  check(id: string, entries: readonly FileEntry[]): FileCheck {
    const contract = this.definition(id); const issues: FileIssue[] = [];
    const fail = (path: string, rule: string, code: string): void => { issues.push({ path, rule, code }); };
    const paths = new Map<string, FileEntry>();
    for (const entry of entries) {
      if (!object(entry) || !isArtifactPath(entry.path) || !['file', 'directory'].includes(entry.kind)
        || entry.kind === 'file' && (!count(entry.bytes) || typeof entry.mediaType !== 'string')) { fail('', '', 'INVALID_ENTRY'); continue; }
      if (paths.has(entry.path)) fail(entry.path, '', 'DUPLICATE_PATH');
      paths.set(entry.path, entry);
    }
    for (const entry of paths.values()) {
      const parts = entry.path.split('/'); parts.pop();
      while (parts.length) {
        const parent = parts.join('/'); if (paths.get(parent)?.kind !== 'directory') fail(entry.path, '', 'MISSING_PARENT_DIRECTORY'); parts.pop();
      }
    }
    if (issues.length) return { valid: false, issues };
    const files = entries.filter((entry): entry is Extract<FileEntry, { kind: 'file' }> => entry.kind === 'file');
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    if (files.length > contract.maxFiles) fail('', '', 'MAX_FILES');
    if (!Number.isSafeInteger(total) || total > contract.maxTotalBytes) fail('', '', 'MAX_TOTAL_BYTES');
    const roots = new Map<string, FileRule>();
    const structuralParents = new Set<string>();
    const memberCounts = new Map<string, number>();
    for (const file of files) {
      const parts = file.path.split('/'); parts.pop();
      while (parts.length) { const parent = parts.join('/'); memberCounts.set(parent, (memberCounts.get(parent) ?? 0) + 1); parts.pop(); }
    }
    for (const rule of contract.rules) {
      const candidates = entries.filter(entry => entry.kind === (rule.kind === 'tree' ? 'directory' : 'file') && matches(rule.match, entry.path));
      if (candidates.length < rule.minCount || candidates.length > rule.maxCount) fail('', rule.id, 'COUNT');
      for (const candidate of candidates) {
        if (roots.has(candidate.path)) {
          fail(candidate.path, rule.id, 'AMBIGUOUS_MATCH'); return { valid: false, issues };
        }
        roots.set(candidate.path, rule);
        const parts = candidate.path.split('/'); parts.pop();
        while (parts.length) { structuralParents.add(parts.join('/')); parts.pop(); }
        if (rule.kind === 'tree') {
          const size = memberCounts.get(candidate.path) ?? 0;
          if (size < rule.minFiles! || size > rule.maxFiles!) fail(candidate.path, rule.id, 'TREE_FILE_COUNT');
        }
      }
    }
    for (const [path, rule] of roots) {
      const parts = path.split('/'); parts.pop();
      while (parts.length) {
        if (roots.get(parts.join('/'))?.kind === 'tree') { fail(path, rule.id, 'AMBIGUOUS_MATCH'); return { valid: false, issues }; }
        parts.pop();
      }
    }
    const assignments: { path: string; rule: string }[] = [];
    const directories: string[] = [];
    for (const entry of entries) {
      let rule = roots.get(entry.path);
      const parts = entry.path.split('/'); parts.pop();
      while (!rule && parts.length) {
        const parent = roots.get(parts.join('/')); if (parent?.kind === 'tree') rule = parent;
        parts.pop();
      }
      if (!rule) {
        if (entry.kind === 'file') fail(entry.path, '', 'UNMATCHED_ENTRY');
        else if (structuralParents.has(entry.path)) directories.push(entry.path);
        continue;
      }
      assignments.push({ path: entry.path, rule: rule.id });
      if (entry.kind === 'directory') directories.push(entry.path);
      if (entry.kind === 'file') {
        if (entry.bytes > rule.maxBytes) fail(entry.path, rule.id, 'MAX_BYTES');
        if (!rule.mediaTypes.includes(entry.mediaType)) fail(entry.path, rule.id, 'MEDIA_TYPE');
        if (entry.mediaType === 'application/json' && rule.jsonContract && !this.json.check(rule.jsonContract, entry.json).valid) fail(entry.path, rule.id, 'JSON_CONTRACT');
      }
    }
    return issues.length ? { valid: false, issues } : { valid: true, assignments, directories };
  }
}
