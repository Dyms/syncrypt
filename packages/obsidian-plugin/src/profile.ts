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

/** "a/b/c.md" → ["a/b", "a"]. Nearest ancestor first. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    out.push(path.slice(0, i));
  }
  return out;
}

export class ProfileMatcher {
  private readonly include: RegExp[];
  private readonly exclude: RegExp[];

  constructor(profile: SyncProfile) {
    this.include = profile.include.map(globToRegExp);
    this.exclude = profile.exclude.map(globToRegExp);
  }

  /**
   * Excluding a FOLDER excludes what is inside it (ADR-0037).
   *
   * This is the whole rule, and both the walk and the engine's `syncable()`
   * answer from it. They used to answer from different halves: the walk pruned
   * a folder whose own path matched an exclude, while `matches()` tested only
   * the file's path — so with `exclude: ["Archive"]` the walk skipped
   * `Archive/`, `syncable("Archive/old.md")` still said yes, and the engine
   * read files it could not see as deleted and tombstoned them FOR EVERY
   * DEVICE. Same class as ADR-0022 and ADR-0025, same cause: one decision with
   * two implementations.
   *
   * It is also what a person means. `Archive` in an exclude list excludes the
   * Archive folder, the way it would in a .gitignore — not "the folder but not
   * its contents", which is not a thing anybody wants.
   */
  private excluded(path: string): boolean {
    if (this.exclude.some((re) => re.test(path))) return true;
    return ancestors(path).some((folder) => this.exclude.some((re) => re.test(folder)));
  }

  matches(path: string): boolean {
    return this.include.some((re) => re.test(path)) && !this.excluded(path);
  }

  /**
   * May a folder contain matches? Prunes directory walks — an optimization
   * that MUST agree with `matches()`, so it is prunable exactly when the
   * folder is excluded (which now covers everything inside it), plus the
   * `Archive/**` spelling, which matches the folder's contents rather than the
   * folder itself.
   */
  folderExcluded(folderPath: string): boolean {
    if (this.excluded(folderPath)) return true;
    return this.exclude.some((re) => re.test(`${folderPath}/`));
  }
}
