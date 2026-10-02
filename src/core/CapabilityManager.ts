import type { LinuxSystem } from "../system/Linux.js";
import type { ProcFs } from "../system/ProcFs.js";
import type { SysFs, CpuTopology, GpuInfo } from "../system/SysFs.js";
import { detectPermissions, type PermissionInfo } from "../system/Permissions.js";
import { detectGraphics, type GraphicsCapabilities } from "../performance/GraphicsManager.js";
import { commandOk } from "../system/Commands.js";

export interface SystemCapabilities {
  cpuAffinity: boolean;
  schedulerPriority: boolean;
  realtimeScheduling: boolean;
  cgroups: boolean;
  namespaces: boolean;
  networkNamespaces: boolean;
  seccomp: boolean;
  firewall: boolean;
  opengl: boolean;
  vulkan: boolean;
  procFs: boolean;
  sysFs: boolean;
}

export interface SandboxCapabilities {
  mountNamespace: boolean;
  pidNamespace: boolean;
  networkNamespace: boolean;
  cgroups: boolean;
  /** Enforceable by Tangerine (a filter is actually installed). Kernel support alone does not count. */
  seccomp: boolean;
  /** Real filesystem isolation (private mount tree) is only possible through bwrap. */
  filesystemIsolation: boolean;
}

export interface HostCapabilities extends SystemCapabilities {
  sandbox: SandboxCapabilities;
  helpers: Record<string, string | undefined>;
  permissions: PermissionInfo;
  topology: CpuTopology;
  gpu: GpuInfo;
  graphics: GraphicsCapabilities;
  cgroupV2: boolean;
  systemdScope: boolean;
  bwrap: boolean;
  unshareUserNs: boolean;
  seccompKernelSupport: boolean;
  marcoCompositor: boolean;
  notes: string[];
}

const HELPERS = ["taskset", "chrt", "nice", "renice", "unshare", "bwrap", "systemd-run", "gsettings", "nft", "iptables", "glxinfo", "vulkaninfo", "ionice"];

export interface CapabilityOptions {
  /** Deep graphics probing (glxinfo / vulkaninfo): slower, used by doctor/inspect. */
  deepGraphics: boolean;
}

/** Probes the host once. Every probe is a real attempt, not a guess from the distro name. */
export class CapabilityManager {
  constructor(
    private readonly sys: LinuxSystem,
    private readonly proc: ProcFs,
    private readonly sysfs: SysFs,
  ) {}

  async detect(opts: CapabilityOptions = { deepGraphics: false }): Promise<HostCapabilities> {
    const notes: string[] = [];
    const helpers: Record<string, string | undefined> = {};
    for (const h of HELPERS) helpers[h] = this.sys.which(h);

    const [permissions, topology, gpu] = await Promise.all([detectPermissions(this.sys, this.proc), this.sysfs.readCpuTopology(), this.sysfs.readGpuInfo()]);
    const graphics = await detectGraphics(this.sys, gpu, { deep: opts.deepGraphics });

    const procFs = await this.sys.exists("/proc/self/status");
    const sysFs = await this.sys.exists("/sys/devices/system/cpu");

    const probe = async (cmd: string, args: string[]): Promise<boolean> => {
      if (!this.sys.which(cmd)) return false;
      return commandOk(await this.sys.execute(cmd, args, { timeoutMs: 4000 }));
    };

    const cpuAffinity = helpers["taskset"] ? await probe("taskset", ["-p", String(process.pid)]) : false;
    const bwrapBase = ["--ro-bind", "/", "/", "--dev", "/dev"];
    const bwrap = helpers["bwrap"] ? await probe("bwrap", [...bwrapBase, "--unshare-user", "true"]) : false;
    const unshareUserNs = helpers["unshare"] ? await probe("unshare", ["--user", "--map-root-user", "true"]) : false;
    const [mnt, pid, net] = await Promise.all([
      bwrap ? probe("bwrap", [...bwrapBase, "--unshare-user", "true"]) : probe("unshare", ["--user", "--map-root-user", "--mount", "true"]),
      bwrap ? probe("bwrap", [...bwrapBase, "--unshare-user", "--unshare-pid", "true"]) : probe("unshare", ["--user", "--map-root-user", "--pid", "--fork", "true"]),
      bwrap ? probe("bwrap", [...bwrapBase, "--unshare-user", "--unshare-net", "true"]) : probe("unshare", ["--user", "--map-root-user", "--net", "true"]),
    ]);

    const cgroupV2 = await this.sys.exists("/sys/fs/cgroup/cgroup.controllers");
    let systemdScope = false;
    if (cgroupV2 && helpers["systemd-run"] && this.sys.env()["XDG_RUNTIME_DIR"]) {
      systemdScope = await probe("systemd-run", ["--user", "--scope", "--quiet", "--collect", "true"]);
    }
    if (!cgroupV2) notes.push("cgroup v2 not mounted: memory/CPU limits unavailable.");
    else if (!systemdScope) notes.push("cgroup v2 present, but an unprivileged systemd user scope could not be created.");

    let seccompKernelSupport = false;
    try {
      seccompKernelSupport = /^Seccomp:/m.test(await this.sys.readFile("/proc/self/status"));
    } catch {
      seccompKernelSupport = false;
    }
    const firewallTool = !!(helpers["nft"] || helpers["iptables"]);
    const firewall = firewallTool && (permissions.hasNetAdmin || permissions.isRoot);

    let marco = false;
    if (helpers["gsettings"]) {
      marco = commandOk(await this.sys.execute("gsettings", ["get", "org.mate.Marco.general", "compositing-manager"], { timeoutMs: 3000 }));
    }
    if (!bwrap) notes.push("bubblewrap (bwrap) not usable: filesystem isolation unavailable. Install it with `sudo apt install bubblewrap` for private mount trees.");
    notes.push("seccomp: kernel " + (seccompKernelSupport ? "supports" : "does not report") + " seccomp, but Tangerine does not yet install a filter (not claimed as enforced).");

    return {
      cpuAffinity,
      schedulerPriority: true, // setpriority(2) via os.setPriority: always present on Linux
      realtimeScheduling: !!helpers["chrt"] && (permissions.hasSysNice || (permissions.rtprioLimit ?? 0) > 0),
      cgroups: systemdScope,
      namespaces: unshareUserNs || bwrap,
      networkNamespaces: net,
      seccomp: false,
      firewall,
      opengl: graphics.opengl,
      vulkan: graphics.vulkan,
      procFs,
      sysFs,
      sandbox: { mountNamespace: mnt, pidNamespace: pid, networkNamespace: net, cgroups: systemdScope, seccomp: false, filesystemIsolation: bwrap },
      helpers,
      permissions,
      topology,
      gpu,
      graphics,
      cgroupV2,
      systemdScope,
      bwrap,
      unshareUserNs,
      seccompKernelSupport,
      marcoCompositor: marco,
      notes,
    };
  }
}
