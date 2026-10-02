/**
 * LinuxSystem: the mockable seam between Tangerine and the host kernel (spec §42).
 *
 * ABI boundaries (spec §25). Tangerine ships no native addon and no FFI; every kernel
 * interaction is routed through one of these three audited paths:
 *
 *  1. Filesystem reads (/proc, /sys): text -> parsers in ProcFs.ts / SysFs.ts.
 *
 *  2. setpriority(2)/getpriority(2) via Node's os.setPriority/os.getPriority:
 *       TS number (validated integer, pid >= 0, prio in [-20,19])
 *         -> libuv uv_os_setpriority(uv_pid_t pid /*int32*\/, int priority /*int32*\/)
 *         -> setpriority(PRIO_PROCESS, pid, prio)
 *         -> errno mapped to a thrown Error with .code ('EACCES','EPERM','ESRCH') and .errno (negative)
 *       No pointers, buffers or arrays cross the boundary; nothing to own or free.
 *       Note: PRIO_PROCESS on Linux applies to one *thread* (the tgid's leader); children
 *       inherit it at fork. Tangerine therefore applies nice via the launch wrapper
 *       (race-free, inherited by the whole tree) and uses this call only for
 *       user-configured background rules.
 *
 *  3. sched_setaffinity(2) via the util-linux `taskset` helper (argv, no shell):
 *       TS number[] (validated, de-duplicated, sorted non-negative ints, each < 8192)
 *         -> comma-joined decimal string "2,3" as one argv element (UTF-8, NUL-free)
 *         -> taskset builds the cpu_set_t bitmask (unsigned long[] sized by the helper)
 *         -> sched_setaffinity(pid_t /*int32*\/, size_t, cpu_set_t*)
 *         -> exit status 0 / non-zero, stderr carries strerror(errno)
 *       The cpu_set_t buffer is owned by the helper process and freed on its exit.
 *
 *  4. kill(2) via process.kill(pid, signal): pid int32 (negative = process group),
 *     signal name string -> libuv -> kill(2); ESRCH/EPERM surface as .code.
 */
import { readFile, readdir, realpath, stat, mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { getPriority, setPriority } from "node:os";
import { commandOk, type CommandOptions, type CommandResult, type CommandRunner } from "./Commands.js";
import { TangerineError } from "../core/Errors.js";

export interface LinuxSystem {
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  mkdir(path: string, mode?: number): Promise<void>;
  writeFile(path: string, data: string, mode?: number): Promise<void>;
  remove(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  execute(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
  setAffinity(pid: number, cpus: number[]): Promise<void>;
  getAffinity(pid: number): Promise<number[] | undefined>;
  setPriority(pid: number, nice: number): void;
  getPriority(pid: number): number;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  isAlive(pid: number): boolean;
  env(): Readonly<Record<string, string | undefined>>;
  uid(): number;
  /** Locate an executable on PATH without spawning anything. */
  which(binary: string): string | undefined;
}

export function normalizeCpuList(cpus: readonly number[]): number[] {
  const set = new Set<number>();
  for (const c of cpus) {
    if (!Number.isInteger(c) || c < 0 || c >= 8192) {
      throw new TangerineError({ code: "AFFINITY_FAILED", subsystem: "system", message: `invalid CPU id ${String(c)}`, recoverable: true });
    }
    set.add(c);
  }
  return [...set].sort((a, b) => a - b);
}

export function formatCpuList(cpus: readonly number[]): string {
  return normalizeCpuList(cpus).join(",");
}

export class RealLinuxSystem implements LinuxSystem {
  constructor(private readonly runner: CommandRunner) {}

  readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
  readDir(path: string): Promise<string[]> {
    return readdir(path);
  }
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  realpath(path: string): Promise<string> {
    return realpath(path);
  }
  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
  async mkdir(path: string, mode = 0o700): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }
  writeFile(path: string, data: string, mode = 0o600): Promise<void> {
    return writeFile(path, data, { mode });
  }
  remove(path: string): Promise<void> {
    return rm(path, { recursive: true, force: true });
  }
  mkdtemp(prefix: string): Promise<string> {
    return mkdtemp(prefix);
  }
  execute(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    return this.runner.run(command, args, options);
  }

  async setAffinity(pid: number, cpus: number[]): Promise<void> {
    const list = formatCpuList(cpus);
    if (!list) throw new TangerineError({ code: "AFFINITY_FAILED", subsystem: "system", message: "empty CPU list", recoverable: true });
    // -a: apply to every thread of the process, -p: operate on an existing pid, -c: list syntax.
    const r = await this.runner.run("taskset", ["-a", "-p", "-c", list, String(pid)]);
    if (!commandOk(r)) {
      throw new TangerineError({
        code: "AFFINITY_FAILED",
        subsystem: "system",
        message: `taskset failed for pid ${pid}: ${r.spawnError ?? r.stderr.trim()}`,
        recoverable: true,
        fallback: "continue without CPU affinity",
      });
    }
  }

  async getAffinity(pid: number): Promise<number[] | undefined> {
    const r = await this.runner.run("taskset", ["-p", "-c", String(pid)]);
    if (!commandOk(r)) return undefined;
    const m = /:\s*([0-9,\-]+)\s*$/.exec(r.stdout.trim());
    const { parseCpuList } = await import("./SysFs.js");
    return m?.[1] ? parseCpuList(m[1]) : undefined;
  }

  setPriority(pid: number, nice: number): void {
    setPriority(pid, nice);
  }
  getPriority(pid: number): number {
    return getPriority(pid);
  }
  kill(pid: number, signal: NodeJS.Signals | 0): void {
    process.kill(pid, signal);
  }
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: string }).code === "EPERM";
    }
  }
  env(): Readonly<Record<string, string | undefined>> {
    return process.env;
  }
  uid(): number {
    return process.getuid?.() ?? -1;
  }
  which(binary: string): string | undefined {
    if (binary.includes("/")) return existsSync(binary) ? binary : undefined;
    const path = process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
    for (const dir of path.split(":")) {
      if (!dir) continue;
      const candidate = `${dir}/${binary}`;
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
}

/** Synchronous read used only on the emergency-exit path where awaiting is impossible. */
export function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
