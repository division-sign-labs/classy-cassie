// packages/cli/src/render.ts
// Plain-CLI table rendering (§10). Kept separable from data computation so a
// fuller TUI can replace it post-MVP.

import pc from "picocolors";

export function renderTable(headers: string[], rows: (string | number)[][]): string {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[], colorize?: (s: string) => string) =>
    r.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  return [pc.bold(line(headers)), sep, ...rows.map((r) => line(r.map(String)))].join("\n");
}

export function money(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  return `$${n.toFixed(2)}`;
}

export function num(n: number | undefined, dp = 4): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  return String(Math.round(n * 10 ** dp) / 10 ** dp);
}

export function shortRef(ref: string): string {
  return ref.length > 20 ? `${ref.slice(0, 10)}…${ref.slice(-6)}` : ref;
}
