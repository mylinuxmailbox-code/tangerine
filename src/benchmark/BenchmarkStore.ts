import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkResult } from "./BenchmarkRunner.js";

/** Persists results as one JSON file per run under <state>/benchmarks. */
export class BenchmarkStore {
  constructor(private readonly stateDir: string) {}
  private get dir(): string {
    return join(this.stateDir, "benchmarks");
  }

  async save(r: BenchmarkResult): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const safeLabel = r.label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
    const path = join(this.dir, `${r.timestamp.replace(/[:.]/g, "-")}_${safeLabel}_${r.id.slice(0, 8)}.json`);
    await writeFile(path, JSON.stringify(r, null, 2), { mode: 0o600 });
    return path;
  }

  async list(): Promise<BenchmarkResult[]> {
    try {
      const names = (await readdir(this.dir)).filter((n) => n.endsWith(".json")).sort();
      const out: BenchmarkResult[] = [];
      for (const n of names) {
        try {
          out.push(JSON.parse(await readFile(join(this.dir, n), "utf8")) as BenchmarkResult);
        } catch {
          /* skip unreadable file */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Select runs by label (exact) or label prefix. */
  async byLabel(label: string): Promise<BenchmarkResult[]> {
    return (await this.list()).filter((r) => r.label === label);
  }

  /** Backend recorded by `tangerine benchmark --experiment graphics --save-preference` (never inferred silently). */
  async graphicsPreference(): Promise<"opengl" | "vulkan" | undefined> {
    try {
      const j = JSON.parse(await readFile(join(this.stateDir, "graphics-preference.json"), "utf8")) as { backend?: string };
      return j.backend === "opengl" || j.backend === "vulkan" ? j.backend : undefined;
    } catch {
      return undefined;
    }
  }

  async saveGraphicsPreference(backend: "opengl" | "vulkan", evidence: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.stateDir, "graphics-preference.json"), JSON.stringify({ backend, evidence, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  }
}
