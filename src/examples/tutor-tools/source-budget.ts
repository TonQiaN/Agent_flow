/** Host-owned consumer limit, independent of the grading schema and engine. */
export function sourceByteBudget(value = 128 * 1024 ** 2): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 ** 2) throw new Error('INVALID_TUTOR_SOURCE_BUDGET');
  return value;
}
