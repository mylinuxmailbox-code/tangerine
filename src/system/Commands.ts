import { spawn } from "node:child_process";
import { hasNul } from "../utils/Validation.js";
import { monotonicMs } from "../utils/Timing.js";
import type { Logger } from "../utils/Logger.js";

export interface CommandOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
  /** Cap captured output per stream (bytes). Protects the control plane's memory. */
  maxBuffer?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  /** -1 when the process could not be started or was killed by a signal. */
  exitCode: number;
  signal?: NodeJS.Signals;
  durationMs: number;
  timedOut: boolean;
  /** Set when spawn itself failed (e.g. ENOENT). */
  spawnError?: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

/**
 * The single place external helper binaries are executed (spec §26).
 * - never uses a shell: argv is passed straight to execve(2)
 * - never rejects: failures are reported in the result so callers handle them explicitly
 * - keeps a bounded audit trail of every invocation
 */
export class RealCommandRunner implements CommandRunner {
  readonly history: Array<{ command: string; args: string[]; exitCode: number; durationMs: number }> = [];
  constructor(private readonly logger?: Logger) {}

  run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    const started = monotonicMs();
    const maxBuffer = options.maxBuffer ?? 1 << 20;
    const timeoutMs = options.timeoutMs ?? 10_000;

    if (hasNul(command) || args.some(hasNul)) {
      return Promise.resolve(this.finish({ command, args, stdout: "", stderr: "", exitCode: -1, durationMs: 0, timedOut: false, spawnError: "NUL byte in argv" }));
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const done = (r: Omit<CommandResult, "durationMs" | "command" | "args" | "timedOut"> & { timedOut?: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this.finish({ command, args, durationMs: monotonicMs() - started, timedOut, ...r }));
      };

      let child;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
          shell: false,
        });
      } catch (e) {
        return done({ stdout, stderr, exitCode: -1, spawnError: String(e) });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.setEncoding("utf8").on("data", (d: string) => {
        if (stdout.length < maxBuffer) stdout += d.slice(0, maxBuffer - stdout.length);
      });
      child.stderr?.setEncoding("utf8").on("data", (d: string) => {
        if (stderr.length < maxBuffer) stderr += d.slice(0, maxBuffer - stderr.length);
      });
      child.on("error", (e) => done({ stdout, stderr, exitCode: -1, spawnError: e.message }));
      child.on("close", (code, signal) =>
        done({ stdout, stderr, exitCode: code ?? -1, signal: signal ?? undefined }),
      );
      if (options.input !== undefined && child.stdin) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.input);
      }
    });
  }

  private finish(r: CommandResult): CommandResult {
    this.history.push({ command: r.command, args: r.args, exitCode: r.exitCode, durationMs: r.durationMs });
    if (this.history.length > 200) this.history.shift();
    this.logger?.debug("command", { command: r.command, args: r.args, exitCode: r.exitCode, durationMs: r.durationMs });
    return r;
  }
}

export function commandOk(r: CommandResult): boolean {
  return r.exitCode === 0 && !r.timedOut && !r.spawnError;
}
