import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { MountSpec, SandboxConfig } from "../config/schema.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { Logger } from "../utils/Logger.js";
import { TangerineError } from "../core/Errors.js";

export const SANDBOX_HOME = "/home/tangerine";
export const SANDBOX_SHADER_CACHE = "/tangerine/shader-cache";
const MARKER = ".tangerine-owned";

export interface SessionDir {
  path: string;
  homeDir: string;
}

/**
 * Owns the per-session private directory and builds the sandbox mount list.
 * With bubblewrap, mounts live only inside the sandbox's private mount namespace, so there
 * is nothing mounted on the HOST that could leak or need unmounting; the only host resource
 * is this directory, created 0700 with an ownership marker and removed on cleanup.
 */
export class MountManager {
  private dir?: SessionDir;

  constructor(
    private readonly sys: LinuxSystem,
    private readonly logger: Logger,
  ) {}

  async createSessionDir(runtimeDir: string, sessionId: string): Promise<SessionDir> {
    const path = join(runtimeDir, `session-${sessionId.slice(0, 8)}-${randomBytes(3).toString("hex")}`);
    try {
      await this.sys.mkdir(runtimeDir, 0o700);
      await this.sys.mkdir(path, 0o700);
      await this.sys.writeFile(join(path, MARKER), sessionId + "\n");
      const homeDir = join(path, "home");
      await this.sys.mkdir(homeDir, 0o700);
      this.dir = { path, homeDir };
      this.logger.info("mount.session_dir", { path });
      return this.dir;
    } catch (cause) {
      throw new TangerineError({ code: "MOUNT_FAILED", subsystem: "mount", message: `Cannot create private session directory ${path}`, recoverable: false, cause, hostModified: false });
    }
  }

  get sessionDir(): SessionDir | undefined {
    return this.dir;
  }

  /** Mounts every sandboxed graphical workload needs, derived from explicit config flags. */
  async systemMounts(cfg: SandboxConfig, env: Readonly<Record<string, string | undefined>>, shaderCacheHostDir?: string, create = true): Promise<{ mounts: MountSpec[]; allowedPrefixes: string[] }> {
    const mounts: MountSpec[] = [];
    const allowedPrefixes: string[] = [];
    if (this.dir) mounts.push({ source: this.dir.homeDir, target: SANDBOX_HOME, kind: "bind", readOnly: false, purpose: "private empty HOME for the workload" });
    if (shaderCacheHostDir) {
      if (create) await this.sys.mkdir(shaderCacheHostDir, 0o700); // dry-run (create=false) must not touch the host
      mounts.push({ source: shaderCacheHostDir, target: SANDBOX_SHADER_CACHE, kind: "bind", readOnly: false, optional: !create, purpose: "persistent Mesa shader cache" });
    }
    if (cfg.allowDisplay) {
      mounts.push({ source: "/tmp/.X11-unix", target: "/tmp/.X11-unix", kind: "bind", readOnly: false, optional: true, purpose: "X11 display socket" });
      const xauth = env["XAUTHORITY"] ?? (env["HOME"] ? join(env["HOME"], ".Xauthority") : undefined);
      if (xauth) {
        // The MIT-MAGIC-COOKIE is a display credential: required for X11 auth, hence read-only and file-only.
        allowedPrefixes.push(xauth);
        mounts.push({ source: xauth, target: xauth, kind: "bind", readOnly: true, optional: true, purpose: "X11 authority cookie (display access)" });
      }
    }
    if (cfg.allowGpu) {
      mounts.push({ source: "/dev/dri", target: "/dev/dri", kind: "bind", readOnly: false, device: true, optional: true, purpose: "GPU render nodes (Mesa)" });
    }
    return { mounts, allowedPrefixes };
  }

  /** Idempotent. Only removes a directory that carries our marker. */
  async destroy(): Promise<void> {
    const d = this.dir;
    if (!d) return;
    this.dir = undefined;
    if (await this.sys.exists(join(d.path, MARKER))) {
      await this.sys.remove(d.path);
      this.logger.info("mount.session_dir_removed", { path: d.path });
    }
  }
}
