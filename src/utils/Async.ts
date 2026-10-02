export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Resolves with `undefined` on timeout instead of throwing; callers decide how to react. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs async tasks one-by-one, collecting failures instead of aborting. */
export async function runAll<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
): Promise<{ item: T; error: unknown }[]> {
  const failures: { item: T; error: unknown }[] = [];
  for (const item of items) {
    try {
      await fn(item);
    } catch (error) {
      failures.push({ item, error });
    }
  }
  return failures;
}

/** Fire-and-forget guard: a periodic job that never overlaps itself. */
export class SingleFlightTimer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(
    private readonly job: () => Promise<void> | void,
    private readonly intervalMs: number,
    private readonly onError: (e: unknown) => void,
  ) {}
  start(runImmediately = true): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.running) return; // skip tick rather than queue up work on a slow host
      this.running = true;
      try {
        await this.job();
      } catch (e) {
        this.onError(e);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), this.intervalMs);
    this.timer.unref(); // sampling must never keep the process alive
    if (runImmediately) void tick();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
