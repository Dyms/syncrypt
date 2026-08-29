// Is this endpoint carrying the credentials in the clear?
//
// Kept pure and separate from the settings tab so the rule is unit-testable:
// getting this wrong means telling someone their plaintext connection is fine.

/**
 * True when the endpoint is plain HTTP to somewhere that is NOT this machine.
 *
 * Loopback is exempt on purpose: a local MinIO on `http://127.0.0.1:9000` is
 * how people test, the traffic never leaves the host, and warning about it
 * would teach users to ignore the warning that matters.
 */
export function endpointIsPlaintext(endpoint: string): boolean {
  const trimmed = endpoint.trim();
  if (!/^http:\/\//i.test(trimmed)) return false;
  let host: string;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return false; // not a URL yet — the user is still typing
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return false;
  if (host === "[::1]") return false;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  return true;
}
