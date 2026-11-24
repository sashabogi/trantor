// Number formats and CSV for the Usage screen (#13991).
export const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
export function fmtMoney(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} K`;
  return String(Math.round(n));
}
export const fmtPct = (num: number, den: number): string => (den > 0 ? `${Math.round((num / den) * 100)}%` : "n/a");

const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (head: string[], rows: string[][]): string => [head, ...rows].map(r => r.map(csvCell).join(",")).join("\n") + "\n";

/** Hands the text to the user as a file; the webview has no save dialog of its own. */
export function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
