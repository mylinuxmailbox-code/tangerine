export type Metric<T> =
  | { available: true; value: T; timestamp: number }
  | { available: false; reason: string; timestamp: number };

export function ok<T>(value: T, timestamp = Date.now()): Metric<T> {
  return { available: true, value, timestamp };
}

export function unavailable<T = never>(reason: string, timestamp = Date.now()): Metric<T> {
  return { available: false, reason, timestamp };
}

/** Unwraps a metric or returns undefined; prevents fake zeros leaking into aggregates. */
export function valueOf<T>(m: Metric<T>): T | undefined {
  return m.available ? m.value : undefined;
}
