import { SingleFlightTimer } from "../utils/Async.js";
import type { Logger } from "../utils/Logger.js";
import { errMsg } from "../core/Errors.js";

export interface Sampler {
  readonly name: string;
  sample(): Promise<void>;
}

/**
 * Runs each sampler on its own interval. Timers are unref'd and single-flight, so a slow
 * filesystem can never queue up work or keep the process alive. Sampling is independent of UI rendering.
 */
export class MonitorManager {
  private timers: SingleFlightTimer[] = [];
  private readonly failures = new Map<string, number>();

  constructor(private readonly logger: Logger) {}

  add(sampler: Sampler, intervalMs: number): void {
    this.timers.push(
      new SingleFlightTimer(
        () => sampler.sample(),
        intervalMs,
        (e) => {
          // Log the first failure per sampler loudly, then only count: a broken /sys file must not spam logs.
          const n = (this.failures.get(sampler.name) ?? 0) + 1;
          this.failures.set(sampler.name, n);
          if (n === 1) this.logger.warn("monitor.sample_failed", { sampler: sampler.name, error: errMsg(e) });
        },
      ),
    );
  }

  start(): void {
    for (const t of this.timers) t.start();
  }

  stop(): void {
    for (const t of this.timers) t.stop();
    this.timers = [];
  }

  get failureCounts(): ReadonlyMap<string, number> {
    return this.failures;
  }
}
