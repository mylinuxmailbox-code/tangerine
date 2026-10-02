import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { arch, release } from "node:os";
import type { LinuxSystem } from "./Linux.js";
import type { ProcFs } from "./ProcFs.js";

/** Isolates Node/Bun differences (spec §44). Both expose node:child_process. */
export interface RuntimePlatform {
  name: "node" | "bun";
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  getVersion(): string;
}

export function detectRuntimePlatform(): RuntimePlatform {
  const bunVersion = (process.versions as Record<string, string | undefined>)["bun"];
  return {
    name: bunVersion ? "bun" : "node",
    spawn: (command, args, options) => spawn(command, args, options),
    getVersion: () => bunVersion ?? process.versions.node,
  };
}

export interface PlatformInfo {
  arch: string;
  kernel: string;
  distro?: string;
  distroVersion?: string;
  distroCodename?: string;
  desktop?: string;
  sessionType?: string;
  cpuModel?: string;
  totalMemKb?: number;
  isLinux: boolean;
  isX86_64: boolean;
  isMintMate: boolean;
  runtime: { name: "node" | "bun"; version: string };
}

export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

export async function detectPlatform(sys: LinuxSystem, proc: ProcFs): Promise<PlatformInfo> {
  let osr: Record<string, string> = {};
  try {
    osr = parseOsRelease(await sys.readFile("/etc/os-release"));
  } catch {
    /* non-standard distro */
  }
  const env = sys.env();
  const desktop = env["XDG_CURRENT_DESKTOP"] ?? env["DESKTOP_SESSION"];
  const rt = detectRuntimePlatform();
  let totalMemKb: number | undefined;
  try {
    totalMemKb = (await proc.readMemInfo()).totalKb;
  } catch {
    totalMemKb = undefined;
  }
  const isLinux = process.platform === "linux";
  const distro = osr["NAME"];
  return {
    arch: arch(),
    kernel: release(),
    distro,
    distroVersion: osr["VERSION_ID"],
    distroCodename: osr["VERSION_CODENAME"] ?? osr["UBUNTU_CODENAME"],
    desktop,
    sessionType: env["XDG_SESSION_TYPE"],
    cpuModel: await proc.readCpuModel(),
    totalMemKb,
    isLinux,
    isX86_64: arch() === "x64",
    isMintMate: /mint/i.test(distro ?? "") && /mate/i.test(desktop ?? ""),
    runtime: { name: rt.name, version: rt.getVersion() },
  };
}
