// Comparing plugin versions — pure, because the naive answer is wrong in
// exactly the case that matters.
//
// "1.0.0-beta.9" and "1.0.0-beta.10" are the two versions most likely to be
// running side by side on somebody's devices, and a string comparison puts
// them in the wrong order: "9" > "1". A vault is coordinated by devices that
// disagree about which of them is stale, so this has to be right.

/** -1, 0, 1 — semver order, or null when either side is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;

  for (let i = 0; i < 3; i++) {
    const l = left.release[i] ?? 0;
    const r = right.release[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  // Semver §11: a release outranks any prerelease of the same numbers.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;

  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    // A shorter prerelease sorts first: beta < beta.1.
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    // Numeric identifiers compare as numbers and rank below alphanumeric ones
    // — which is what puts beta.9 before beta.10 rather than after it.
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1;
    if (ln) return -1;
    if (rn) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

interface Parsed {
  release: number[];
  pre: string[];
}

function parseVersion(raw: string): Parsed | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (m === null) return null;
  return {
    release: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
}

/** How this client stands against the version that last wrote to the vault. */
export type VersionSkew = "same" | "client-behind" | "client-ahead" | "unknown";

/**
 * `writer` is the version recorded in the manifest we just read, and is absent
 * on manifests published before this was recorded — which is itself the signal
 * that something old is writing to this vault.
 */
export function versionSkew(writer: string | undefined, self: string | undefined): VersionSkew {
  if (self === undefined || self === "") return "unknown";
  if (writer === undefined || writer === "") return "client-ahead";
  const cmp = compareVersions(self, writer);
  if (cmp === null) return "unknown";
  return cmp === 0 ? "same" : cmp < 0 ? "client-behind" : "client-ahead";
}
