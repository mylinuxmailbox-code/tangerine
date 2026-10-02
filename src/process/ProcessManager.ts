import type { SpawnOptions } from "node:child_process";
import { TangerineError, errMsg } from "../core/Errors.js";
import type { RuntimePlatform } from "../system/Platform.js";
import type { Logger } from "../utils/Logger.js";
import { ChildManagedProcess } from "./ManagedProcess.js";
import { hasNul } from "../utils/Validation.js";
import { runAll } from "../utils/Async.js";

export interface SpawnRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Hard wall-clock limit; the group is terminated when exceeded. */
  timeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL when terminating. */
  graceMs?: number;
  label: string;
}

/** Owns every process Tangerine spawns (spec §19, §58). */
export class ProcessManager {
  private readonly procs = new Set<ChildManagedProcess>();
  private readonly timers = new Map<ChildManagedProcess, NodeJS.Timeout>();
  private accepting = true;

  constructor(
    private readonly platform: RuntimePlatform,
    private readonly logger: Logger,
  ) {}

  get all(): readonly ChildManagedProcess[] {
    return [...this.procs];
  }

  /** Stop new work (shutdown step 1). */
  stopAccepting(): void {
    this.accepting = false;
  }

  async spawn(req: SpawnRequest): Promise<ChildManagedProcess> {
    if (!this.accepting) throw new TangerineError({ code: "PROCESS_START_FAILED", subsystem: "process", message: "shutting down: not accepting new processes", recoverable: false });
    if (!req.command || hasNul(req.command) || req.args.some(hasNul)) {
      throw new TangerineError({ code: "PROCESS_START_FAILED", subsystem: "process", message: "invalid command or argument (empty or contains NUL)", recoverable: false });
    }
    const options: SpawnOptions = {
      cwd: req.cwd,
      env: req.env, // deterministic: nothing is inherited implicitly
      detached: true, // setsid(2): own session + process group so we can signal the whole tree
      stdio: ["ignore", "pipe", "pipe"],
      shell: false, // argv goes straight to execve(2); no shell parsing, no injection surface
    };
    const child = this.platform.spawn(req.command, req.args, options);
    // spawn() reports ENOENT/EACCES asynchronously; wait for 'spawn' or 'error'.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) =>
        reject(
          new TangerineError({
            code: "PROCESS_START_FAILED",
            subsystem: "process",
            message: `Failed to start ${req.command}: ${errMsg(e)}`,
            recoverable: false,
            cause: e,
            hint: "Check the executable path and permissions. No host mutation was made by this step.",
          }),
        ),
      );
    });
    const mp = new ChildManagedProcess(child, req.command, req.args, req.label);
    this.procs.add(mp);
    this.logger.info("process.started", { label: req.label, command: req.command, argc: req.args.length }, mp.pid);
    void mp.wait().then((code) => {
      this.logger.info("process.exited", { label: req.label, exitCode: code, signal: mp.signal }, mp.pid);
      const t = this.timers.get(mp);
      if (t) clearTimeout(t);
      this.timers.delete(mp);
    });
    if (req.timeoutMs && req.timeoutMs > 0) {
      const t = setTimeout(() => {
        this.logger.warn("process.timeout", { label: req.label, timeoutMs: req.timeoutMs }, mp.pid);
        void mp.terminate("SIGTERM", req.graceMs ?? 8000);
      }, req.timeoutMs);
      t.unref();
      this.timers.set(mp, t);
    }
    return mp;
  }

  /** Terminates everything still running; failures are logged, never thrown. */
  async terminateAll(graceMs = 8000): Promise<void> {
    const live = [...this.procs].filter((p) => p.isRunning);
    const failures = await runAll(live, (p) => p.terminate("SIGTERM", graceMs));
    for (const f of failures) this.logger.error("process.terminate_failed", { error: errMsg(f.error) }, f.item.pid);
  }

  /** Synchronous last resort for process 'exit' handlers (no awaiting possible). */
  killAllSync(): void {
    for (const p of this.procs) if (p.isRunning) p.signalGroup("SIGKILL");
  }
}
