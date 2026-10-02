import { createHash } from "node:crypto";
import type { TangerineConfig } from "../config/schema.js";
import type { PlatformInfo } from "../system/Platform.js";
import type { HostCapabilities } from "../core/CapabilityManager.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { ProcFs } from "../system/ProcFs.js";

/** Host + runtime state recorded with every result so runs are comparable and reproducible (spec §36-37). */
export interface SystemState {
  kernel: string;
  distro?: string;
  desktop?: string;
  cpuModel?: string;
  logicalCpus: number;
  physicalCores: number;
  totalMemMb?: number;
  cpuGovernor?: string;
  cpuFreqDriver?: string;
  swappiness?: string;
  gpuDriver?: string;
  renderer?: string;
  mesaVersion?: string;
  runtimeAdapter: string;
  runtimeVersion?: string;
  nodeVersion: string;
  /** Hash of the effective config; equal hashes = same configuration. */
  configHash: string;
  /** Hash of everything except the knobs under test: if equal across two results the hardware/software baseline matches. */
  environmentHash: string;
}

export function hashObject(o: unknown): string {
  return createHash("sha256").update(JSON.stringify(o, Object.keys(flatten(o)).sort())).digest("hex").slice(0, 12);
}

function flatten(o: unknown, acc: Record<string, true> = {}): Record<string, true> {
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { acc[k] = true; flatten(v, acc); }
  return acc;
}

export async function captureSystemState(args: {
  platform: PlatformInfo;
  caps: HostCapabilities;
  config: Readonly<TangerineConfig>;
  runtimeId: string;
  runtimeVersion?: string;
  sys: LinuxSystem;
  proc: ProcFs;
}): Promise<SystemState> {
  const { platform, caps, config } = args;
  const first = caps.topology.cpus.find((c) => c.online);
  const environment = {
    kernel: platform.kernel,
    cpu: platform.cpuModel,
    ram: platform.totalMemKb ? Math.round(platform.totalMemKb / 1024 / 256) : undefined, // ~256 MB buckets: RAM readout jitters
    renderer: caps.graphics.renderer,
    mesa: caps.graphics.mesaVersion,
    runtime: args.runtimeId,
    runtimeVersion: args.runtimeVersion,
    executable: config.runtime.executable,
    args: config.runtime.args,
  };
  return {
    kernel: platform.kernel,
    distro: [platform.distro, platform.distroVersion].filter(Boolean).join(" ") || undefined,
    desktop: platform.desktop,
    cpuModel: platform.cpuModel,
    logicalCpus: caps.topology.logicalCount,
    physicalCores: caps.topology.physicalCoreCount,
    totalMemMb: platform.totalMemKb ? Math.round(platform.totalMemKb / 1024) : undefined,
    cpuGovernor: first?.governor,
    cpuFreqDriver: caps.topology.freqDriver,
    swappiness: await args.proc.readSysctl("vm.swappiness"),
    gpuDriver: caps.graphics.kernelDriver,
    renderer: caps.graphics.renderer,
    mesaVersion: caps.graphics.mesaVersion,
    runtimeAdapter: args.runtimeId,
    runtimeVersion: args.runtimeVersion,
    nodeVersion: platform.runtime.version,
    configHash: hashObject(config),
    environmentHash: hashObject(environment),
  };
}

/** Differences that make two results NOT directly comparable. */
export function baselineMismatches(a: SystemState, b: SystemState): string[] {
  const out: string[] = [];
  const chk = (name: string, x: unknown, y: unknown): void => {
    if (x !== y) out.push(`${name}: ${String(x)} vs ${String(y)}`);
  };
  chk("kernel", a.kernel, b.kernel);
  chk("cpu", a.cpuModel, b.cpuModel);
  chk("mesa", a.mesaVersion, b.mesaVersion);
  chk("renderer", a.renderer, b.renderer);
  chk("runtime", `${a.runtimeAdapter}@${a.runtimeVersion}`, `${b.runtimeAdapter}@${b.runtimeVersion}`);
  chk("governor", a.cpuGovernor, b.cpuGovernor);
  chk("environment", a.environmentHash, b.environmentHash);
  return out;
}
