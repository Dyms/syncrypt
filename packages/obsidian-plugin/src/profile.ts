// Sync profile: include/exclude patterns deciding what is synced (RFC-0002
// FR-1..3, ADR-0010 defaults). Minimal glob support — no dependencies:
//   **  any characters, including "/"
//   *   any characters except "/"
//   ?   one character except "/"

export interface SyncProfile {
  include: string[];
  exclude: string[];
}

/** ADR-0010: `.obsidian/` (which contains sync-trash) and dot-folders are
 *  local state, never content. */
export const DEFAULT_PROFILE: SyncProfile = {
  include: ["**"],
  exclude: [".*", ".*/**", "**/.DS_Store"],
};

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += "[\\s\\S]*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += (ch ?? "").replace(REGEX_SPECIALS, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

export class ProfileMatcher {
  private readonly include: RegExp[];
  private readonly exclude: RegExp[];

  constructor(profile: SyncProfile) {
    this.include = profile.include.map(globToRegExp);
    this.exclude = profile.exclude.map(globToRegExp);
  }

  matches(path: string): boolean {
    return (
      this.include.some((re) => re.test(path)) &&
      !this.exclude.some((re) => re.test(path))
    );
  }

  /** May a folder contain matches? Used to prune directory walks. */
  folderExcluded(folderPath: string): boolean {
    // A folder is prunable when the folder itself matches an exclude pattern
    // that ends in a way that covers everything below it.
    return this.exclude.some(
      (re) => re.test(folderPath) || re.test(`${folderPath}/`),
    );
  }
}
