export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function hasNul(s: string): boolean {
  return s.includes("\0");
}

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Deep clone + freeze: session configuration must not be mutated after start (spec §56). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Recursive merge: plain objects merge, arrays and scalars replace. `undefined` is ignored. */
export function deepMerge<T>(base: T, ...overlays: unknown[]): T {
  let out: unknown = clone(base);
  for (const o of overlays) out = mergeTwo(out, o);
  return out as T;
}

function mergeTwo(a: unknown, b: unknown): unknown {
  if (b === undefined) return a;
  if (isRecord(a) && isRecord(b)) {
    const res: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      res[k] = mergeTwo(a[k], v);
    }
    return res;
  }
  return Array.isArray(b) ? structuredClone(b) : b;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
