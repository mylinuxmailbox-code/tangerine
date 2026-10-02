import type { ChildProcess } from "node:child_process";
import { withTimeout } from "../utils/Async.js";

export interface ManagedProcess {
  pid: number;
  command: string;
  args: string[];
  startedAt: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  terminate(signal?: NodeJS.Signals): Promise<void>;
  wait(): Promise<number>;
}

export type OutputListener = (chunk: string) => void;

/**
 * Wraps one spawned child. The child is a process-group leader (spawned detached), so
 * signals go to `-pid` and reach every descendant that stayed in the group - the initial
 * PID is NOT assumed to be the whole workload (spec §19).
 */
export class ChildManagedProcess implements ManagedProcess {
  readonly pid: number;
  readonly startedAt = Date.now();
  exitCode?: number;
  signal?: NodeJS.Signals;
  private readonly exited: Promise<number>;
  private done = false;
  private readonly stdoutListeners = new Set<OutputListener>();
  private readonly stderrListeners = new Set<OutputListener>();
  /** Recent stderr tail for diagnostics (bounded). */
  private tail = "";

  constructor(
    private readonly child: ChildProcess,
    readonly command: string,
    readonly args: string[],
    readonly label: string,
  ) {
    this.pid = child.pid as number;
    child.stdout?.setEncoding("utf8").on("data", (d: string) => this.stdoutListeners.forEach((l) => l(d)));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      this.tail = (this.tail + d).slice(-4096);
      this.stderrListeners.forEach((l) => l(d));
    });
    this.exited = new Promise<number>((resolve) => {
      child.once("close", (code, signal) => {
        this.done = true;
        this.exitCode = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : -1);
        this.signal = signal ?? undefined;
        resolve(this.exitCode);
      });
      child.once("error", () => {
        if (!this.done) {
          this.done = true;
          this.exitCode = -1;
          resolve(-1);
        }
      });
    });
  }

  get isRunning(): boolean {
    return !this.done;
  }
  get stderrTail(): string {
    return this.tail;
  }
  onStdout(l: OutputListener): () => void {
    this.stdoutListeners.add(l);
    return () => this.stdoutListeners.delete(l);
  }
  onStderr(l: OutputListener): () => void {
    this.stderrListeners.add(l);
    return () => this.stderrListeners.delete(l);
  }

  /** Signals the whole process group; falls back to the single PID if the group is gone. */
  signalGroup(signal: NodeJS.Signals): boolean {
    for (const target of [-this.pid, this.pid]) {
      try {
        process.kill(target, signal);
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === "ESRCH") continue;
        return false;
      }
    }
    return false;
  }

  wait(): Promise<number> {
    return this.exited;
  }

  /** SIGTERM (or given signal) -> wait `graceMs` -> SIGKILL the group. Idempotent. */
  async terminate(signal: NodeJS.Signals = "SIGTERM", graceMs = 8000): Promise<void> {
    if (this.done) return;
    this.signalGroup(signal);
    const r = await withTimeout(this.exited, graceMs);
    if (r === undefined && !this.done) {
      this.signalGroup("SIGKILL");
      await withTimeout(this.exited, 3000);
    }
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
export function signalNumber(s: NodeJS.Signals): number | undefined {
  return SIGNALS[s];
}
