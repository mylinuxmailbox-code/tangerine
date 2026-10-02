import type { PartialConfig } from "./schema.js";

/**
 * Maps TANGERINE_* environment variables to config overrides.
 * Only an explicit allow-list is honoured, so a polluted environment cannot flip security settings silently.
 */
export function configFromEnvironment(env: Readonly<Record<string, string | undefined>>): PartialConfig {
  const out: Record<string, Record<string, unknown>> = {};
  const set = (section: string, key: string, value: unknown): void => {
    (out[section] ??= {})[key] = value;
  };
  const bool = (v: string): boolean => /^(1|true|yes|on)$/i.test(v);
  const e = (k: string): string | undefined => (env[k] !== undefined && env[k] !== "" ? env[k] : undefined);

  const profile = e("TANGERINE_PROFILE");
  if (profile) set("performance", "profile", profile);
  const gfx = e("TANGERINE_GRAPHICS");
  if (gfx) set("graphics", "backend", gfx);
  const vsync = e("TANGERINE_VSYNC");
  if (vsync) set("graphics", "vsync", bool(vsync));
  const net = e("TANGERINE_NETWORK");
  if (net) set("network", "mode", net);
  const lvl = e("TANGERINE_LOG_LEVEL");
  if (lvl) set("logging", "level", lvl);
  const ui = e("TANGERINE_UI");
  if (ui) set("ui", "enabled", bool(ui));
  const adapter = e("TANGERINE_RUNTIME");
  if (adapter) set("runtime", "adapter", adapter);
  return out as PartialConfig;
}
