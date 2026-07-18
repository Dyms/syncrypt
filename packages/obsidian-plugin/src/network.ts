// Resource-aware auto-sync network policy (RFC-0004 §Resource-aware
// auto-sync): wifi-only on mobile by default. Connection detection in a
// webview is best-effort — when the platform cannot tell us, we allow the
// sync rather than silently wedging (manual "Sync now" always bypasses this).

export interface ConnectionInfo {
  onLine?: boolean;
  /** NetworkInformation.type where available ("cellular", "wifi", …). */
  type?: string;
}

export function autoSyncAllowed(wifiOnly: boolean, conn: ConnectionInfo | null): boolean {
  if (conn?.onLine === false) return false; // definitely offline
  if (!wifiOnly) return true;
  const type = conn?.type;
  if (type === undefined) return true; // unknown network kind → best effort
  return type !== "cellular";
}

/** Read the live connection info from the platform (best effort). */
export function currentConnection(): ConnectionInfo | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { connection?: { type?: string } };
  const info: ConnectionInfo = { onLine: nav.onLine };
  if (nav.connection?.type !== undefined) info.type = nav.connection.type;
  return info;
}
