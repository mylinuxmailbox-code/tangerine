export function bar(percent: number, width = 16): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + " ".repeat(width - filled);
}

export function colorFor(percent: number): "green" | "yellow" | "red" {
  return percent >= 85 ? "red" : percent >= 60 ? "yellow" : "green";
}

export function gb(kb: number, digits = 1): string {
  return (kb / 1048576).toFixed(digits);
}

export function mb(kb: number): string {
  return Math.round(kb / 1024).toString();
}

export function fmt(n: number | undefined, d = 1): string {
  return n === undefined || !Number.isFinite(n) ? "n/a" : n.toFixed(d);
}
