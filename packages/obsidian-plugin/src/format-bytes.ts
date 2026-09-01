// Byte sizes for humans. Pure and on its own so the log renderer — which must
// never import anything that pulls in `obsidian` — can use it too.

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "B"}`;
}
