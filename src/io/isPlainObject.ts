/**
 * Type-guard narrowing `unknown` to a record-like object so callers can
 * index it with bracket access without a cast. Returns true for arrays
 * too — narrow further at the callsite if you need plain objects only.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
