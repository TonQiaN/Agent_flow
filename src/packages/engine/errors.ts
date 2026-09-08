/** Messages contain only engine-owned categories, never arbitrary implementation errors. */
export class DefinitionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DefinitionError';
  }
}
