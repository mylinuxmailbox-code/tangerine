import { posix } from "node:path";
import type { MountSpec } from "../config/schema.js";
import type { LinuxSystem } from "../system/Linux.js";
import { TangerineError } from "../core/Errors.js";
import { hasNul } from "../utils/Validation.js";

/** Paths (relative to $HOME) that hold credentials or session secrets. Never mountable. */
const HOME_SECRETS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".config/gh", ".config/gcloud",
  ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".local/share/keyrings",
  ".password-store", ".config/Bitwarden", ".bash_history", ".npmrc", ".pypirc",
];
const SYSTEM_SECRETS = ["/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/sudoers.d", "/etc/ssh", "/root", "/boot", "/var/run/docker.sock", "/run/docker.sock", "/var/lib/docker", "/run/user"];
const ALLOWED_DEVICES = ["/dev/dri", "/dev/snd", "/dev/input", "/dev/kvm"];

export interface PolicyContext {
  sys: LinuxSystem;
  home: string;
  exposeHome: boolean;
  /** Extra directories that are legal even though they sit under /run/user (e.g. the display socket). */
  allowedPrefixes?: string[];
}

export interface ValidatedMount extends MountSpec {
  /** Symlink-resolved source (bind mounts). */
  resolvedSource?: string;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

export function deniedPaths(home: string): string[] {
  return [...SYSTEM_SECRETS, ...HOME_SECRETS.map((p) => posix.join(home, p))];
}

/**
 * Validates one mount: absolute+normalised paths, symlinks resolved BEFORE the policy check
 * (so a symlink cannot smuggle ~/.ssh into the sandbox), and rejection of any source that is,
 * contains, or lies inside a sensitive path. `/`, `/home`, `$HOME` itself need explicit opt-in.
 */
export async function validateMount(spec: MountSpec, ctx: PolicyContext): Promise<ValidatedMount | undefined> {
  const reject = (msg: string): never => {
    throw new TangerineError({ code: "MOUNT_REJECTED", subsystem: "sandbox", message: `Mount ${spec.target}: ${msg}`, recoverable: false, hint: "Expose a narrower directory, or review sandbox.exposeHome." });
  };
  if (hasNul(spec.target) || (spec.source && hasNul(spec.source))) reject("NUL byte in path");
  const t = spec.target;
  if (!posix.isAbsolute(t) || t !== posix.normalize(t) || (t.length > 1 && t.endsWith("/"))) reject(`target must be an absolute normalised path (got ${JSON.stringify(t)})`);
  if (spec.target.split("/").includes("..")) reject("target contains '..'");
  if (!spec.purpose) reject("a 'purpose' is required for every mount (audit trail)");
  if (spec.kind !== "bind") return { ...spec };

  const source = spec.source;
  if (!source || !posix.isAbsolute(source)) return reject("bind source must be an absolute path");
  if (!(await ctx.sys.exists(source))) {
    if (spec.optional) return undefined;
    return reject(`source ${source} does not exist`);
  }
  const real = await ctx.sys.realpath(source);

  if (spec.device) {
    if (!ALLOWED_DEVICES.some((d) => real === d || real.startsWith(d + "/"))) reject(`device passthrough only allowed for ${ALLOWED_DEVICES.join(", ")}`);
    return { ...spec, resolvedSource: real };
  }
  if (!spec.readOnly && (real === "/usr" || real.startsWith("/usr/") || real.startsWith("/proc") || real.startsWith("/sys"))) reject("system trees may only be mounted read-only");
  if (real === "/" || real === "/home") reject("refusing to expose the host root or /home");
  if (real === ctx.home && !ctx.exposeHome) reject("refusing to expose your whole home directory (set sandbox.exposeHome=true to override)");
  const allowed = ctx.allowedPrefixes ?? [];
  for (const d of deniedPaths(ctx.home)) {
    if (allowed.some((p) => real === p || real.startsWith(p + "/"))) continue;
    if (real === d || real.startsWith(d + "/")) reject(`source ${real} is inside sensitive path ${d}`);
    // A parent of a secret would expose it. $HOME itself is allowed only with the explicit exposeHome opt-in.
    if (d.startsWith(real + "/") && !(ctx.exposeHome && real === ctx.home)) reject(`source ${real} contains sensitive path ${d}`);
  }
  return { ...spec, resolvedSource: real };
}

export async function validateMounts(specs: MountSpec[], ctx: PolicyContext): Promise<ValidatedMount[]> {
  const out: ValidatedMount[] = [];
  const targets = new Set<string>();
  for (const s of specs) {
    const v = await validateMount(s, ctx);
    if (!v) continue;
    if (targets.has(v.target)) {
      throw new TangerineError({ code: "MOUNT_REJECTED", subsystem: "sandbox", message: `Duplicate mount target ${v.target}`, recoverable: false });
    }
    targets.add(v.target);
    out.push(v);
  }
  return out;
}
