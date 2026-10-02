import type { LinuxSystem } from "./Linux.js";

/** Parses kernel cpulist syntax: "0-1,3,5-6" -> [0,1,3,5,6]. Invalid input yields []. */
export function parseCpuList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.trim().split(",")) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return [];
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo || hi - lo > 8192) return [];
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

export interface CpuInfo {
  logicalId: number;
  coreId?: number;
  physicalPackageId?: number;
  online: boolean;
  /** Logical CPUs sharing this physical core (SMT siblings), incl. itself. */
  siblings: number[];
  minFreqKhz?: number;
  maxFreqKhz?: number;
  curFreqKhz?: number;
  governor?: string;
}

export interface CpuTopology {
  cpus: CpuInfo[];
  online: number[];
  possible: number[];
  logicalCount: number;
  physicalCoreCount: number;
  smt: boolean;
  numaNodes: number;
  /** cpufreq driver, e.g. intel_pstate / acpi-cpufreq. */
  freqDriver?: string;
}

export interface GpuDevice {
  card: string;
  vendorId?: string;
  deviceId?: string;
  driver?: string;
  isIntel: boolean;
  /** MHz values from i915 sysfs, only when readable without privileges. */
  curFreqMhz?: number;
  actFreqMhz?: number;
  maxFreqMhz?: number;
  minFreqMhz?: number;
  boostFreqMhz?: number;
  throttleReasons?: string[];
}

export interface GpuInfo {
  devices: GpuDevice[];
  debugfsReadable: boolean;
}

export interface SysFs {
  readCpuTopology(): Promise<CpuTopology>;
  readGpuInfo(): Promise<GpuInfo>;
  readCpuFrequenciesKhz(): Promise<Map<number, number>>;
  readThermalMilliC(): Promise<number | undefined>;
  readValue(path: string): Promise<string | undefined>;
}

export function buildTopology(raw: {
  possible: number[];
  online: number[];
  perCpu: Map<number, { coreId?: number; pkgId?: number; siblings?: number[]; minF?: number; maxF?: number; curF?: number; gov?: string }>;
  numaNodes: number;
  freqDriver?: string;
}): CpuTopology {
  const onlineSet = new Set(raw.online);
  const cpus: CpuInfo[] = raw.possible.map((id) => {
    const r = raw.perCpu.get(id) ?? {};
    return {
      logicalId: id,
      coreId: r.coreId,
      physicalPackageId: r.pkgId,
      online: onlineSet.has(id),
      siblings: r.siblings && r.siblings.length ? r.siblings : [id],
      minFreqKhz: r.minF,
      maxFreqKhz: r.maxF,
      curFreqKhz: r.curF,
      governor: r.gov,
    };
  });
  // Physical core identity is (package, coreId). Logical IDs do NOT map 1:1 to cores (spec §9).
  const coreKeys = new Set<string>();
  for (const c of cpus.filter((x) => x.online)) {
    coreKeys.add(c.coreId === undefined ? `L${c.logicalId}` : `${c.physicalPackageId ?? 0}:${c.coreId}`);
  }
  const logicalCount = raw.online.length;
  return {
    cpus,
    online: raw.online,
    possible: raw.possible,
    logicalCount,
    physicalCoreCount: coreKeys.size || logicalCount,
    smt: coreKeys.size > 0 && coreKeys.size < logicalCount,
    numaNodes: raw.numaNodes,
    freqDriver: raw.freqDriver,
  };
}

/** Groups online logical CPUs by physical core, each group sorted ascending. */
export function coreGroups(t: CpuTopology): number[][] {
  const groups = new Map<string, number[]>();
  for (const c of t.cpus) {
    if (!c.online) continue;
    const key = c.coreId === undefined ? `L${c.logicalId}` : `${c.physicalPackageId ?? 0}:${c.coreId}`;
    const g = groups.get(key) ?? [];
    g.push(c.logicalId);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b)).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

export class LinuxSysFs implements SysFs {
  private topo?: CpuTopology;
  constructor(private readonly sys: LinuxSystem, private readonly root = "/sys") {}

  async readValue(path: string): Promise<string | undefined> {
    try {
      return (await this.sys.readFile(path)).trim();
    } catch {
      return undefined;
    }
  }

  private async num(path: string): Promise<number | undefined> {
    const v = await this.readValue(path);
    if (v === undefined || !/^-?\d+$/.test(v)) return undefined;
    return Number(v);
  }

  /** Topology (ids, siblings) is static; frequencies are refreshed by readCpuFrequenciesKhz(). */
  async readCpuTopology(): Promise<CpuTopology> {
    if (this.topo) return this.topo;
    const base = `${this.root}/devices/system/cpu`;
    const possible = parseCpuList((await this.readValue(`${base}/possible`)) ?? "");
    let online = parseCpuList((await this.readValue(`${base}/online`)) ?? "");
    if (!possible.length) {
      // Extremely unusual; fall back to enumerating cpuN directories.
      const names = await this.sys.readDir(base).catch(() => [] as string[]);
      for (const n of names) if (/^cpu\d+$/.test(n)) possible.push(Number(n.slice(3)));
      possible.sort((a, b) => a - b);
    }
    if (!online.length) online = [...possible];
    const perCpu = new Map<number, { coreId?: number; pkgId?: number; siblings?: number[]; minF?: number; maxF?: number; curF?: number; gov?: string }>();
    for (const id of possible) {
      const d = `${base}/cpu${id}`;
      const sib = await this.readValue(`${d}/topology/thread_siblings_list`);
      perCpu.set(id, {
        coreId: await this.num(`${d}/topology/core_id`),
        pkgId: await this.num(`${d}/topology/physical_package_id`),
        siblings: sib ? parseCpuList(sib) : undefined,
        minF: await this.num(`${d}/cpufreq/cpuinfo_min_freq`),
        maxF: await this.num(`${d}/cpufreq/cpuinfo_max_freq`),
        curF: await this.num(`${d}/cpufreq/scaling_cur_freq`),
        gov: await this.readValue(`${d}/cpufreq/scaling_governor`),
      });
    }
    const nodes = (await this.sys.readDir(`${this.root}/devices/system/node`).catch(() => [] as string[])).filter((n) => /^node\d+$/.test(n));
    this.topo = buildTopology({
      possible,
      online,
      perCpu,
      numaNodes: nodes.length,
      freqDriver: await this.readValue(`${base}/cpu0/cpufreq/scaling_driver`),
    });
    return this.topo;
  }

  async readCpuFrequenciesKhz(): Promise<Map<number, number>> {
    const topo = await this.readCpuTopology();
    const out = new Map<number, number>();
    for (const id of topo.online) {
      const f = await this.num(`${this.root}/devices/system/cpu/cpu${id}/cpufreq/scaling_cur_freq`);
      if (f !== undefined) out.set(id, f);
    }
    return out;
  }

  /** Hottest thermal zone in milli-degrees C, if any zone is readable. */
  async readThermalMilliC(): Promise<number | undefined> {
    const base = `${this.root}/class/thermal`;
    const zones = (await this.sys.readDir(base).catch(() => [] as string[])).filter((n) => n.startsWith("thermal_zone"));
    let max: number | undefined;
    for (const z of zones) {
      const t = await this.num(`${base}/${z}/temp`);
      if (t !== undefined && (max === undefined || t > max)) max = t;
    }
    return max;
  }

  async readGpuInfo(): Promise<GpuInfo> {
    const base = `${this.root}/class/drm`;
    const names = (await this.sys.readDir(base).catch(() => [] as string[])).filter((n) => /^card\d+$/.test(n));
    const devices: GpuDevice[] = [];
    for (const card of names) {
      const dev = `${base}/${card}/device`;
      const vendorId = await this.readValue(`${dev}/vendor`);
      let driver: string | undefined;
      try {
        driver = (await this.sys.realpath(`${dev}/driver`)).split("/").pop();
      } catch {
        driver = undefined;
      }
      // i915 exposes these in /sys/class/drm/cardN without root. Newer drivers (xe) differ: report what exists.
      const reasons: string[] = [];
      for (const r of ["gt_throttle_reason_status"]) {
        const v = await this.num(`${base}/${card}/${r}`);
        if (v) reasons.push(`status=0x${v.toString(16)}`);
      }
      devices.push({
        card,
        vendorId,
        deviceId: await this.readValue(`${dev}/device`),
        driver,
        isIntel: vendorId === "0x8086",
        curFreqMhz: await this.num(`${base}/${card}/gt_cur_freq_mhz`),
        actFreqMhz: await this.num(`${base}/${card}/gt_act_freq_mhz`),
        maxFreqMhz: await this.num(`${base}/${card}/gt_max_freq_mhz`),
        minFreqMhz: await this.num(`${base}/${card}/gt_min_freq_mhz`),
        boostFreqMhz: await this.num(`${base}/${card}/gt_boost_freq_mhz`),
        throttleReasons: reasons.length ? reasons : undefined,
      });
    }
    let debugfsReadable = false;
    try {
      await this.sys.readDir("/sys/kernel/debug/dri");
      debugfsReadable = true;
    } catch {
      debugfsReadable = false;
    }
    return { devices, debugfsReadable };
  }
}
