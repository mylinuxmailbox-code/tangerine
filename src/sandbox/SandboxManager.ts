import type { SandboxConfig, MountSpec } from "../config/schema.js";
import type { HostCapabilities, SandboxCapabilities } from "../core/CapabilityManager.js";
import type { LinuxSystem } from "../system/Linux.js";
import { TangerineError } from "../core/Errors.js";
import { buildUnshareArgs } from "./NamespaceManager.js";
import { seccompStatus } from "./SeccompManager.js";
import { validateMounts, type ValidatedMount } from "./FilesystemPolicy.js";

export interface SandboxPlan {
  enabled: boolean;
  backend: "bwrap" | "unshare" | "none";
  /** What is ACTUALLY enforced - never what was merely requested (spec §21, §63.2). */
  enforced: SandboxCapabilities;
  mounts: ValidatedMount[];
  warnings: string[];
  /** argv prefix that launches the workload inside the sandbox. */
  buildWrapper(env: SandboxWrapperInput): string[];
}

export interface SandboxWrapperInput {
  cwd?: string;
  /** Sandbox-internal HOME (a private, empty directory), if any. */
  home?: string;
}

/** Host paths whose *contents* are system code; mounted read-only. Merged-/usr aware (Mint 21.3). */
const ETC_ALLOW = [
  "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/alternatives", "/etc/fonts", "/etc/ssl/certs", "/etc/ca-certificates",
  "/etc/localtime", "/etc/timezone", "/etc/locale.alias", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/vulkan", "/etc/drirc",
  "/etc/OpenCL", "/etc/machine-id", "/etc/os-release", "/etc/lsb-release", "/etc/hosts", "/etc/resolv.conf", "/etc/xdg",
];

export interface BwrapInput {
  unsharePid: boolean;
  unshareNet: boolean;
  usrSymlinks: string[]; // e.g. ["bin","sbin","lib","lib64"] that are symlinks into usr on the host
  usrPlain: string[]; // dirs that are real directories on the host and need ro-bind
  mounts: ValidatedMount[];
  etcPresent: string[];
  cwd?: string;
  home?: string;
}

/**
 * Pure argv builder for bubblewrap (testable without bwrap installed).
 * Facility: clone(2) namespaces (user, ipc, uts, optional pid/net) + a private mount tree
 * assembled with bind mounts. Nothing is mounted on the HOST, so there is nothing to unmount.
 * `--die-with-parent` ties the sandbox lifetime to Tangerine; `--new-session` blocks TIOCSTI injection.
 */
export function buildBwrapArgs(i: BwrapInput): string[] {
  const a: string[] = ["bwrap", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-ipc", "--unshare-uts"];
  if (i.unsharePid) a.push("--unshare-pid");
  if (i.unshareNet) a.push("--unshare-net");
  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run");
  a.push("--ro-bind", "/usr", "/usr");
  for (const d of i.usrSymlinks) a.push("--symlink", `usr/${d}`, `/${d}`);
  for (const d of i.usrPlain) a.push("--ro-bind", `/${d}`, `/${d}`);
  for (const p of i.etcPresent) a.push("--ro-bind", p, p);
  for (const m of i.mounts) {
    switch (m.kind) {
      case "tmpfs": a.push("--tmpfs", m.target); break;
      case "proc": a.push("--proc", m.target); break;
      case "dev": a.push("--dev", m.target); break;
      case "bind": {
        const src = m.resolvedSource ?? (m.source as string);
        a.push(m.device ? "--dev-bind" : m.readOnly ? "--ro-bind" : "--bind", src, m.target);
      }
    }
  }
  if (i.home) a.push("--setenv", "HOME", i.home);
  if (i.cwd) a.push("--chdir", i.cwd);
  a.push("--");
  return a;
}

export interface SandboxRequest {
  config: SandboxConfig;
  /** Network namespace needed because mode != unrestricted. */
  needNetNamespace: boolean;
  mounts: MountSpec[];
  home: string;
  allowedPrefixes?: string[];
}

export class SandboxManager {
  constructor(private readonly sys: LinuxSystem) {}

  async plan(req: SandboxRequest, caps: HostCapabilities): Promise<SandboxPlan> {
    const cfg = req.config;
    const warnings: string[] = [];
    const none = (why: string): SandboxPlan => {
      warnings.push(why);
      return { enabled: false, backend: "none", enforced: { mountNamespace: false, pidNamespace: false, networkNamespace: false, cgroups: caps.sandbox.cgroups, seccomp: false, filesystemIsolation: false }, mounts: [], warnings, buildWrapper: () => [] };
    };

    if (!cfg.enabled || cfg.backend === "none") return none("sandbox disabled by configuration: the workload runs with the user's full privileges");

    let backend: "bwrap" | "unshare" | "none" = "none";
    if (cfg.backend === "bwrap" || cfg.backend === "auto") if (caps.bwrap) backend = "bwrap";
    if (backend === "none" && (cfg.backend === "unshare" || cfg.backend === "auto") && caps.unshareUserNs) backend = "unshare";
    if (cfg.backend === "bwrap" && !caps.bwrap) backend = "none";

    if (backend === "none") {
      if (cfg.failIfDegraded) {
        throw new TangerineError({ code: "SANDBOX_UNAVAILABLE", subsystem: "sandbox", message: "No usable sandbox backend (bubblewrap or unprivileged user namespaces).", recoverable: false, hint: "sudo apt install bubblewrap, or set sandbox.failIfDegraded=false." });
      }
      return none("no sandbox backend available (bwrap missing and user namespaces unusable): running UNSANDBOXED");
    }

    const exposeNet = req.needNetNamespace && cfg.networkNamespace !== false;
    const policyMounts: MountSpec[] = [...req.mounts];
    const mounts = await validateMounts(policyMounts, { sys: this.sys, home: req.home, exposeHome: cfg.exposeHome, allowedPrefixes: req.allowedPrefixes });

    if (backend === "bwrap") {
      const usrSymlinks: string[] = [];
      const usrPlain: string[] = [];
      for (const d of ["bin", "sbin", "lib", "lib32", "lib64", "libx32"]) {
        if (!(await this.sys.exists(`/${d}`))) continue;
        const real = await this.sys.realpath(`/${d}`);
        if (real === `/usr/${d}`) usrSymlinks.push(d);
        else usrPlain.push(d);
      }
      const etcPresent: string[] = [];
      for (const p of ETC_ALLOW) if (await this.sys.exists(p)) etcPresent.push(p);
      const pid = cfg.pidNamespace;
      return {
        enabled: true,
        backend,
        enforced: { mountNamespace: true, pidNamespace: pid, networkNamespace: exposeNet, cgroups: caps.sandbox.cgroups, seccomp: seccompStatus(caps.seccompKernelSupport).enforced, filesystemIsolation: true },
        mounts,
        warnings,
        buildWrapper: (w) => buildBwrapArgs({ unsharePid: pid, unshareNet: exposeNet, usrSymlinks, usrPlain, mounts, etcPresent, cwd: w.cwd, home: w.home }),
      };
    }

    warnings.push("unshare backend: PID/network namespaces only. The host filesystem is NOT isolated (install bubblewrap for that).");
    if (mounts.length) warnings.push("mount specs are not enforced by the unshare backend and are ignored");
    return {
      enabled: true,
      backend,
      enforced: { mountNamespace: cfg.mountNamespace, pidNamespace: cfg.pidNamespace, networkNamespace: exposeNet, cgroups: caps.sandbox.cgroups, seccomp: false, filesystemIsolation: false },
      mounts: [],
      warnings,
      buildWrapper: () => buildUnshareArgs({ mount: cfg.mountNamespace, pid: cfg.pidNamespace, net: exposeNet }),
    };
  }
}
