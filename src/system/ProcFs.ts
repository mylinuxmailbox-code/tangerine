import type { LinuxSystem } from "./Linux.js";

export interface MemInfo {
  totalKb: number;
  freeKb: number;
  availableKb: number;
  buffersKb: number;
  cachedKb: number;
  anonPagesKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
  swapCachedKb: number;
  shmemKb: number;
  dirtyKb: number;
}

export interface CpuTimes {
  user: number; nice: number; system: number; idle: number;
  iowait: number; irq: number; softirq: number; steal: number;
}
export interface CpuStat {
  total: CpuTimes;
  perCpu: Map<number, CpuTimes>;
  ctxt?: number;
}

export interface VmStat {
  pswpin: number;
  pswpout: number;
  pgfault: number;
  pgmajfault: number;
  pgscanDirect?: number;
  pgscanKswapd?: number;
  allocstall?: number;
}

export interface ProcessStatus {
  pid: number;
  name: string;
  state: string;
  ppid: number;
  vmSizeKb?: number;
  vmRssKb?: number;
  rssAnonKb?: number;
  rssFileKb?: number;
  rssShmemKb?: number;
  vmSwapKb?: number;
  threads?: number;
  cpusAllowed?: string;
  cpusAllowedList?: string;
}

export interface ProcessStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  pgrp: number;
  startTimeTicks: number;
  utime: number;
  stime: number;
  nice: number;
  threads: number;
}

const kb = (s: string | undefined): number => (s === undefined ? 0 : Number.parseInt(s, 10) || 0);

export function parseKeyValueKb(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const m = /^\s*(\d+)/.exec(line.slice(idx + 1));
    if (m?.[1]) map.set(line.slice(0, idx).trim(), Number.parseInt(m[1], 10));
  }
  return map;
}

export function parseMemInfo(text: string): MemInfo {
  const m = parseKeyValueKb(text);
  const g = (k: string): number => m.get(k) ?? 0;
  const free = g("MemFree");
  const buffers = g("Buffers");
  const cached = g("Cached");
  return {
    totalKb: g("MemTotal"),
    freeKb: free,
    // Kernels < 3.14 lack MemAvailable; approximate conservatively rather than reporting 0.
    availableKb: m.has("MemAvailable") ? g("MemAvailable") : free + buffers + cached,
    buffersKb: buffers,
    cachedKb: cached,
    anonPagesKb: g("AnonPages"),
    swapTotalKb: g("SwapTotal"),
    swapFreeKb: g("SwapFree"),
    swapCachedKb: g("SwapCached"),
    shmemKb: g("Shmem"),
    dirtyKb: g("Dirty"),
  };
}

function parseCpuLine(fields: string[]): CpuTimes {
  const n = (i: number): number => Number(fields[i] ?? 0) || 0;
  return { user: n(0), nice: n(1), system: n(2), idle: n(3), iowait: n(4), irq: n(5), softirq: n(6), steal: n(7) };
}

export function parseCpuStat(text: string): CpuStat {
  const perCpu = new Map<number, CpuTimes>();
  let total: CpuTimes = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 };
  let ctxt: number | undefined;
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const head = parts[0] ?? "";
    if (head === "cpu") total = parseCpuLine(parts.slice(1));
    else if (/^cpu\d+$/.test(head)) perCpu.set(Number(head.slice(3)), parseCpuLine(parts.slice(1)));
    else if (head === "ctxt") ctxt = Number(parts[1]);
  }
  return { total, perCpu, ctxt };
}

export function busyAndTotal(t: CpuTimes): { busy: number; total: number } {
  // guest time is already accounted for inside user/nice by the kernel.
  const idle = t.idle + t.iowait;
  const busy = t.user + t.nice + t.system + t.irq + t.softirq + t.steal;
  return { busy, total: busy + idle };
}

/** CPU utilisation (0..100) between two cumulative samples; undefined if no ticks elapsed. */
export function cpuUsagePercent(prev: CpuTimes, cur: CpuTimes): number | undefined {
  const a = busyAndTotal(prev);
  const b = busyAndTotal(cur);
  const dTotal = b.total - a.total;
  if (dTotal <= 0) return undefined;
  return Math.min(100, Math.max(0, ((b.busy - a.busy) / dTotal) * 100));
}

export function parseVmStat(text: string): VmStat {
  const m = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && /^\d+$/.test(v)) m.set(k, Number(v));
  }
  return {
    pswpin: m.get("pswpin") ?? 0,
    pswpout: m.get("pswpout") ?? 0,
    pgfault: m.get("pgfault") ?? 0,
    pgmajfault: m.get("pgmajfault") ?? 0,
    pgscanDirect: m.get("pgscan_direct"),
    pgscanKswapd: m.get("pgscan_kswapd"),
    allocstall: sumPrefix(m, "allocstall"),
  };
}

function sumPrefix(m: Map<string, number>, prefix: string): number | undefined {
  let found = false;
  let sum = 0;
  for (const [k, v] of m) {
    if (k.startsWith(prefix)) {
      found = true;
      sum += v;
    }
  }
  return found ? sum : undefined;
}

export function parseProcessStatus(pid: number, text: string): ProcessStatus {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const k = (name: string): number | undefined => {
    const v = fields.get(name);
    return v === undefined ? undefined : kb(v);
  };
  return {
    pid,
    name: fields.get("Name") ?? "",
    state: (fields.get("State") ?? "?").split(/\s+/)[0] ?? "?",
    ppid: Number(fields.get("PPid") ?? 0),
    vmSizeKb: k("VmSize"),
    vmRssKb: k("VmRSS"),
    rssAnonKb: k("RssAnon"),
    rssFileKb: k("RssFile"),
    rssShmemKb: k("RssShmem"),
    vmSwapKb: k("VmSwap"),
    threads: fields.has("Threads") ? Number(fields.get("Threads")) : undefined,
    cpusAllowed: fields.get("Cpus_allowed"),
    cpusAllowedList: fields.get("Cpus_allowed_list"),
  };
}

/**
 * /proc/<pid>/stat: `comm` is parenthesised and may itself contain spaces and ')',
 * so split on the LAST ')' rather than on whitespace.
 */
export function parseProcessStat(text: string): ProcessStat | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).split(" "); // rest[0] is field 3 (state)
  const f = (n: number): number => Number(rest[n - 3] ?? 0);
  if (!Number.isFinite(pid)) return undefined;
  return {
    pid,
    comm: text.slice(open + 1, close),
    state: rest[0] ?? "?",
    ppid: f(4),
    pgrp: f(5),
    utime: f(14),
    stime: f(15),
    nice: f(19),
    threads: f(20),
    startTimeTicks: f(22),
  };
}

export interface Psi {
  someAvg10: number;
  someAvg60: number;
  fullAvg10?: number;
  fullAvg60?: number;
  someTotalUs: number;
}

/** /proc/pressure/{memory,cpu,io}: "some avg10=0.00 avg60=0.00 avg300=0.00 total=123". */
export function parsePsi(text: string): Psi | undefined {
  const line = (kind: string): Record<string, number> | undefined => {
    const m = new RegExp(`^${kind}\\s+(.*)$`, "m").exec(text);
    if (!m?.[1]) return undefined;
    const o: Record<string, number> = {};
    for (const kv of m[1].split(/\s+/)) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined) o[k] = Number(v);
    }
    return o;
  };
  const some = line("some");
  if (!some) return undefined;
  const full = line("full");
  return { someAvg10: some["avg10"] ?? 0, someAvg60: some["avg60"] ?? 0, fullAvg10: full?.["avg10"], fullAvg60: full?.["avg60"], someTotalUs: some["total"] ?? 0 };
}

export interface ProcFs {
  readPsi(resource: "memory" | "cpu" | "io"): Promise<Psi | undefined>;
  readMemInfo(): Promise<MemInfo>;
  readCpuStat(): Promise<CpuStat>;
  readVmStat(): Promise<VmStat>;
  readProcessStatus(pid: number): Promise<ProcessStatus>;
  readProcessStat(pid: number): Promise<ProcessStat | undefined>;
  listPids(): Promise<number[]>;
  readChildren(pid: number): Promise<number[] | undefined>;
  readSelfStatus(): Promise<ProcessStatus>;
  readLimits(): Promise<string>;
  readCpuModel(): Promise<string | undefined>;
  readSysctl(name: string): Promise<string | undefined>;
}

export class LinuxProcFs implements ProcFs {
  private cpuModel: string | undefined | null = null; // static: cached forever
  constructor(private readonly sys: LinuxSystem, private readonly root = "/proc") {}

  async readPsi(resource: "memory" | "cpu" | "io"): Promise<Psi | undefined> {
    try {
      return parsePsi(await this.sys.readFile(`${this.root}/pressure/${resource}`));
    } catch {
      return undefined; // kernel built without PSI or booted with psi=0
    }
  }
  async readMemInfo(): Promise<MemInfo> {
    return parseMemInfo(await this.sys.readFile(`${this.root}/meminfo`));
  }
  async readCpuStat(): Promise<CpuStat> {
    return parseCpuStat(await this.sys.readFile(`${this.root}/stat`));
  }
  async readVmStat(): Promise<VmStat> {
    return parseVmStat(await this.sys.readFile(`${this.root}/vmstat`));
  }
  async readProcessStatus(pid: number): Promise<ProcessStatus> {
    return parseProcessStatus(pid, await this.sys.readFile(`${this.root}/${pid}/status`));
  }
  async readProcessStat(pid: number): Promise<ProcessStat | undefined> {
    try {
      return parseProcessStat(await this.sys.readFile(`${this.root}/${pid}/stat`));
    } catch {
      return undefined; // process exited between listing and reading: normal
    }
  }
  async listPids(): Promise<number[]> {
    const names = await this.sys.readDir(this.root);
    return names.filter((n) => /^\d+$/.test(n)).map(Number);
  }
  async readChildren(pid: number): Promise<number[] | undefined> {
    try {
      // Needs CONFIG_PROC_CHILDREN (enabled on Ubuntu/Mint kernels). One file read instead of a full /proc scan.
      const t = (await this.sys.readFile(`${this.root}/${pid}/task/${pid}/children`)).trim();
      return t ? t.split(/\s+/).map(Number) : [];
    } catch {
      return undefined;
    }
  }
  async readSelfStatus(): Promise<ProcessStatus> {
    return parseProcessStatus(0, await this.sys.readFile(`${this.root}/self/status`));
  }
  async readLimits(): Promise<string> {
    return this.sys.readFile(`${this.root}/self/limits`);
  }
  async readCpuModel(): Promise<string | undefined> {
    if (this.cpuModel !== null) return this.cpuModel;
    try {
      const m = /^model name\s*:\s*(.+)$/m.exec(await this.sys.readFile(`${this.root}/cpuinfo`));
      this.cpuModel = m?.[1]?.trim();
    } catch {
      this.cpuModel = undefined;
    }
    return this.cpuModel;
  }
  async readSysctl(name: string): Promise<string | undefined> {
    try {
      return (await this.sys.readFile(`${this.root}/sys/${name.replace(/\./g, "/")}`)).trim();
    } catch {
      return undefined;
    }
  }
}
