import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MutationJournal, UndoRecord } from "./MutationManager.js";

export interface SessionRecord {
  sessionId: string;
  controllerPid: number;
  /** /proc/<pid>/stat starttime, used to defeat PID reuse when validating ownership. */
  controllerStartTicks?: number;
  startedAt: string;
  runtimePid?: number;
  runtimeStartTicks?: number;
  runtimeAdapter?: string;
  state: string;
  tempDirs: string[];
  undo: UndoRecord[];
  command?: string;
}

export interface Dirs {
  /** Volatile: session file, private runtime dirs (prefers $XDG_RUNTIME_DIR, a per-user tmpfs). */
  runtime: string;
  /** Persistent: logs, benchmarks. */
  state: string;
  /** Persistent cache: shader cache. */
  cache: string;
}

export function resolveDirs(env: Readonly<Record<string, string | undefined>> = process.env): Dirs {
  const home = env["HOME"] || homedir();
  const xdgRuntime = env["XDG_RUNTIME_DIR"];
  return {
    runtime: join(xdgRuntime || join(home, ".cache"), "tangerine"),
    state: join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "tangerine"),
    cache: join(env["XDG_CACHE_HOME"] || join(home, ".cache"), "tangerine"),
  };
}

/**
 * Persists just enough metadata to clean up after a crash (spec §59). The file is
 * rewritten atomically (write temp + rename) so a crash never leaves a half-written record.
 */
export class SessionStore implements MutationJournal {
  private data: SessionRecord;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, init: Omit<SessionRecord, "undo" | "tempDirs" | "state" | "sessionId" | "startedAt"> & Partial<SessionRecord>) {
    this.data = {
      sessionId: randomUUID(),
      startedAt: new Date().toISOString(),
      state: "initializing",
      tempDirs: [],
      undo: [],
      ...init,
    };
  }

  static path(dir: string): string {
    return join(dir, "session.json");
  }

  get snapshot(): Readonly<SessionRecord> {
    return this.data;
  }

  private persist(): Promise<void> {
    const json = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = join(this.dir, `session.json.${process.pid}.tmp`);
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, SessionStore.path(this.dir));
    });
    return this.writeChain;
  }

  update(patch: Partial<SessionRecord>): Promise<void> {
    this.data = { ...this.data, ...patch };
    return this.persist();
  }
  record(undo: UndoRecord): Promise<void> {
    this.data = { ...this.data, undo: [...this.data.undo, undo] };
    return this.persist();
  }
  forget(id: string): Promise<void> {
    this.data = { ...this.data, undo: this.data.undo.filter((u) => u.id !== id) };
    return this.persist();
  }
  addTempDir(path: string): Promise<void> {
    this.data = { ...this.data, tempDirs: [...this.data.tempDirs, path] };
    return this.persist();
  }
  async remove(): Promise<void> {
    await this.writeChain.catch(() => undefined);
    await rm(SessionStore.path(this.dir), { force: true });
  }

  static async read(dir: string): Promise<SessionRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(SessionStore.path(dir), "utf8")) as SessionRecord;
      if (typeof parsed.sessionId !== "string" || typeof parsed.controllerPid !== "number") return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
}

/** Removes orphaned private runtime dirs for sessions that no longer exist. Only `session-*` dirs with our marker. */
export async function listOwnedTempDirs(runtimeDir: string): Promise<string[]> {
  try {
    const names = await readdir(runtimeDir);
    const out: string[] = [];
    for (const n of names) {
      if (!n.startsWith("session-")) continue;
      const p = join(runtimeDir, n);
      try {
        if ((await stat(join(p, ".tangerine-owned"))).isFile()) out.push(p);
      } catch {
        /* no marker: not ours, never touch */
      }
    }
    return out;
  } catch {
    return [];
  }
}
