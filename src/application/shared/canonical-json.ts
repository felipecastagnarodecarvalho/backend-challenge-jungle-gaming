/** JSON value accepted by {@link canonicalJson}. */
export type CanonicalValue = string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue };

/**
 * Deterministic JSON serialisation used for payload hashing:
 * object keys sorted by UTF-16 code unit (`Array.prototype.sort` default),
 * no whitespace, primitives via `JSON.stringify`, arrays keep their order.
 * Two semantically equal payloads always produce the same string.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson: non-finite numbers are not representable');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as CanonicalValue)}`);
  return `{${parts.join(',')}}`;
}
