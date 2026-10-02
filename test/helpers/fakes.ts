import type { LinuxSystem } from "../../src/system/Linux.js";
import type { CommandOptions, CommandResult } from "../../src/system/Commands.js";

export interface ExecCall { command: string; args: string[] }

/** In-memory host: files, directories, symlinks, scripted command results, recorded side effects. No real I/O. */
export class FakeLinuxSystem implements LinuxSystem {
  files = new Map<string, string>();
  dirs = new Set<string>(["/"]);
  links = new Map<string, string>();
  binaries = new Map<string, string>();
  execCalls: ExecCall[] = [];
  execHandler: (c: string, a: string[]) => Partial<CommandResult> | undefined = () => undefined;
  affinityCalls: { pid: number; cpus: number[] }[] = [];
  priorities = new Map<number, number>();
  signals: { pid: number; signal: NodeJS.Signals | 0 }[] = [];
  alive = new Set<number>();
  environment: Record<string, string | undefined> = { HOME: "/home/u", PATH: "/usr/bin:/bin" };
  currentUid = 1000;
  removed: string[] = [];

  addFile(path: string, content: string): this {
    this.files.set(path, content);
    let d = path;
    while ((d = d.slice(0, d.lastIndexOf("/")) || "/") && !this.dirs.has(d)) { this.dirs.add(d); if (d === "/") break; }
    return this;
  }
  addDir(path: string): this {
    this.dirs.add(path);
    return this;
  }
  addLink(from: string, to: string): this {
    this.links.set(from, to);
    this.dirs.add(from);
    return this;
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return v;
  }
  async readDir(path: string): Promise<string[]> {
    if (!this.dirs.has(path) && !this.links.has(path)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    const prefix = path === "/" ? "/" : path + "/";
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs, ...this.links.keys()]) {
      if (p.startsWith(prefix) && p !== path) names.add(p.slice(prefix.length).split("/")[0] as string);
    }
    return [...names];
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path) || this.links.has(path);
  }
  async realpath(path: string): Promise<string> {
    for (const [from, to] of this.links) if (path === from || path.startsWith(from + "/")) return to + path.slice(from.length);
    return path;
  }
  async isDirectory(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.addFile(path, data);
  }
  async remove(path: string): Promise<void> {
    this.removed.push(path);
    for (const k of [...this.files.keys()]) if (k === path || k.startsWith(path + "/")) this.files.delete(k);
    this.dirs.delete(path);
  }
  async mkdtemp(prefix: string): Promise<string> {
    const p = prefix + "abc123";
    this.dirs.add(p);
    return p;
  }
  async execute(command: string, args: string[], _o?: CommandOptions): Promise<CommandResult> {
    this.execCalls.push({ command, args });
    const r = this.execHandler(command, args) ?? {};
    return { command, args, stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false, ...r };
  }
  async setAffinity(pid: number, cpus: number[]): Promise<void> {
    this.affinityCalls.push({ pid, cpus });
  }
  async getAffinity(): Promise<number[] | undefined> {
    return undefined;
  }
  setPriority(pid: number, nice: number): void {
    this.priorities.set(pid, nice);
  }
  getPriority(pid: number): number {
    return this.priorities.get(pid) ?? 0;
  }
  kill(pid: number, signal: NodeJS.Signals | 0): void {
    this.signals.push({ pid, signal });
  }
  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }
  env(): Readonly<Record<string, string | undefined>> {
    return this.environment;
  }
  uid(): number {
    return this.currentUid;
  }
  which(binary: string): string | undefined {
    return this.binaries.get(binary);
  }
}

/** /sys + /proc layout of an i3-6006U: 2 cores x 2 threads, siblings (0,2) and (1,3). */
export function addI3Topology(sys: FakeLinuxSystem): void {
  sys.addFile("/sys/devices/system/cpu/possible", "0-3\n").addFile("/sys/devices/system/cpu/online", "0-3\n");
  const siblings: Record<number, string> = { 0: "0,2", 1: "1,3", 2: "0,2", 3: "1,3" };
  const core: Record<number, number> = { 0: 0, 1: 1, 2: 0, 3: 1 };
  for (let i = 0; i < 4; i++) {
    const b = `/sys/devices/system/cpu/cpu${i}`;
    sys.addFile(`${b}/topology/core_id`, `${core[i]}\n`).addFile(`${b}/topology/physical_package_id`, "0\n").addFile(`${b}/topology/thread_siblings_list`, `${siblings[i]}\n`);
    sys.addFile(`${b}/cpufreq/cpuinfo_max_freq`, "2000000\n").addFile(`${b}/cpufreq/cpuinfo_min_freq`, "400000\n").addFile(`${b}/cpufreq/scaling_cur_freq`, "1800000\n").addFile(`${b}/cpufreq/scaling_governor`, "powersave\n");
  }
  sys.addFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver", "intel_pstate\n");
}
