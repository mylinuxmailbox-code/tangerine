import { randomUUID } from "node:crypto";
import type { PartialConfig } from "../config/schema.js";
import type { SystemState } from "./Baseline.js";
import { sleep } from "../utils/Async.js";
import type { Logger } from "../utils/Logger.js";
import { errMsg } from "../core/Errors.js";

export interface BenchmarkResult {
  id: string;
  timestamp: string;
  durationMs: number;
  graphicsBackend: string;
  cpuAffinity?: number[];
  schedulerPolicy: string;
  avgFps?: number;
  minFps?: number;
  avgFrameTimeMs?: number;
  frameTimeP95Ms?: number;
  cpuUsagePercent: number;
  memoryUsageMb: number;
  swapInPerSecond: number;
  swapOutPerSecond: number;
  startupTimeMs: number;
  // --- extended record (reproducibility) ---
  label: string;
  runIndex: number;
  profile: string;
  niceLevel: number;
  sandboxBackend: string;
  networkMode: string;
  frameTimeStdDevMs?: number;
  droppedFrames?: number;
  fpsSource?: string;
  fpsUnavailableReason?: string;
  processRssMb?: number;
  cpuFreqMhzAvg?: number;
  cpuTempMaxC?: number;
  exitCode?: number;
  endReason: string;
  system: SystemState;
  overlay: PartialConfig;
}

export interface SessionHandle {
  /** Starts, runs for durationMs, stops, cleans up, and returns the result. Must always clean up. */
  runOnce(opts: { durationMs: number; warmupMs: number; label: string; runIndex: number; overlay: PartialConfig }): Promise<BenchmarkResult>;
}

export interface BenchmarkPlanStep {
  label: string;
  overlay: PartialConfig;
}

export interface RunnerOptions {
  runs: number;
  durationMs: number;
  warmupMs: number;
  /** Idle time between runs. Matters on 15 W CPUs: back-to-back runs start thermally soaked. */
  cooldownMs: number;
}

export class BenchmarkRunner {
  constructor(
    private readonly session: SessionHandle,
    private readonly logger: Logger,
    private readonly onProgress?: (msg: string) => void,
  ) {}

  /** Runs every step `runs` times. Order is interleaved (A B A B) so slow drift (thermals) hits steps evenly. */
  async runSteps(steps: BenchmarkPlanStep[], o: RunnerOptions): Promise<Map<string, BenchmarkResult[]>> {
    const results = new Map<string, BenchmarkResult[]>();
    for (const s of steps) results.set(s.label, []);
    for (let run = 0; run < o.runs; run++) {
      for (const step of steps) {
        this.onProgress?.(`run ${run + 1}/${o.runs}: ${step.label}`);
        try {
          const r = await this.session.runOnce({ durationMs: o.durationMs, warmupMs: o.warmupMs, label: step.label, runIndex: run, overlay: step.overlay });
          results.get(step.label)?.push(r);
        } catch (e) {
          this.logger.error("benchmark.run_failed", { label: step.label, run, error: errMsg(e) });
          this.onProgress?.(`FAILED ${step.label} (run ${run + 1}): ${errMsg(e)}`);
        }
        const last = run === o.runs - 1 && step === steps[steps.length - 1];
        if (!last && o.cooldownMs > 0) await sleep(o.cooldownMs);
      }
    }
    return results;
  }
}

export function newResultId(): string {
  return randomUUID();
}
