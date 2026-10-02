/** Monotonic millisecond clock (immune to NTP / wall-clock jumps). */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Wall-clock epoch milliseconds, used only for human-facing timestamps. */
export function wallMs(): number {
  return Date.now();
}

export class Stopwatch {
  private readonly start = monotonicMs();
  elapsedMs(): number {
    return monotonicMs() - this.start;
  }
}
