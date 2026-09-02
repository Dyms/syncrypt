// ADR-0037: excluding a folder excludes what is inside it, and the walk and
// syncable() answer from the same rule.
//
// The defect this pins: with exclude ["Archive"], list() skipped the folder
// while syncable("Archive/old.md") still said yes — so the engine read files
// it could not see as deleted and tombstoned them for every device. Same class
// as ADR-0022 and ADR-0025.

import { describe, expect, it } from "vitest";

import { MemoryStateStore, MemoryStorage } from "@syncrypt/core/testing";
import { openSyncEngine } from "@syncrypt/sdk";

import { DEFAULT_PROFILE, ProfileMatcher, type SyncProfile } from "../src/profile.js";
import { ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const matcher = (exclude: string[]) => new ProfileMatcher({ include: ["**"], exclude });

async function listed(exclude: string[], files: Record<string, string>): Promise<string[]> {
  const adapter = new MockDataAdapter();
  for (const [path, text] of Object.entries(files)) adapter.setFile(path, text);
  const vault = new ObsidianVault(adapter, { include: ["**"], exclude });
  const out: string[] = [];
  for await (const p of vault.list()) out.push(p);
  return out;
}

describe("a bare folder name in exclude", () => {
  const m = matcher(["Archive"]);

  it("excludes the folder AND what is inside it", () => {
    expect(m.matches("Archive/old-1.md")).toBe(false);
    expect(m.matches("Archive/nested/deep.md")).toBe(false);
    expect(m.matches("Archive")).toBe(false);
    expect(m.matches("Note.md")).toBe(true);
  });

  it("THE DEFECT: the walk and syncable() now give the same answer", async () => {
    const files = {
      "Note.md": "keep",
      "Archive/old-1.md": "excluded",
      "Archive/old-2.md": "excluded",
    };
    const adapter = new MockDataAdapter();
    for (const [path, text] of Object.entries(files)) adapter.setFile(path, text);
    const vault = new ObsidianVault(adapter, { include: ["**"], exclude: ["Archive"] });

    const walked: string[] = [];
    for await (const p of vault.list()) walked.push(p);
    expect(walked).toEqual(["Note.md"]);

    // Before the fix this said true for both, which is what produced the
    // tombstones: the engine saw files it could not list and read them as
    // deleted (ADR-0022's "silent data loss on the machines that do sync them").
    for (const path of Object.keys(files)) {
      expect(vault.syncable(path), path).toBe(walked.includes(path));
    }
  });

  it("does not catch a sibling that merely shares the prefix", () => {
    expect(m.matches("Archived/note.md")).toBe(true);
    expect(m.matches("ArchiveNotes.md")).toBe(true);
    expect(m.folderExcluded("Archived")).toBe(false);
  });
});

describe("the other spellings people write", () => {
  it("Archive/** still works, and still prunes the folder", () => {
    const m = matcher(["Archive/**"]);
    expect(m.matches("Archive/old.md")).toBe(false);
    expect(m.folderExcluded("Archive")).toBe(true);
  });

  it("**/temp excludes every temp folder's contents at any depth", () => {
    const m = matcher(["**/temp"]);
    expect(m.matches("a/temp/x.md")).toBe(false);
    expect(m.matches("a/b/temp/deep/x.md")).toBe(false);
    expect(m.matches("a/temporary/x.md")).toBe(true);
  });

  it("a glob folder name covers its contents too", () => {
    const m = matcher(["*.tmp"]);
    expect(m.matches("scratch.tmp")).toBe(false);
    // A folder named like the pattern takes its contents with it. That is the
    // gitignore reading, and the one a person writing "*.tmp" expects.
    expect(m.matches("scratch.tmp/note.md")).toBe(false);
  });
});

describe("nothing else moved", () => {
  it("the DEFAULT profile behaves exactly as before", () => {
    const m = new ProfileMatcher(DEFAULT_PROFILE);
    expect(m.matches("notes/a.md")).toBe(true);
    expect(m.matches("Заметки/вложенная/файл.md")).toBe(true);
    expect(m.matches(".obsidian/appearance.json")).toBe(false);
    expect(m.matches(".hidden/x.md")).toBe(false);
    expect(m.matches("a/b/.DS_Store")).toBe(false);
    // A folder whose name merely contains a dot is NOT a dot-folder.
    expect(m.matches("v1.0/notes.md")).toBe(true);
  });

  it("an empty exclude list excludes nothing", async () => {
    expect(await listed([], { "a.md": "1", "deep/b.md": "2" })).toEqual(["a.md", "deep/b.md"]);
  });

  it("include still has the final say over what is offered at all", () => {
    const m = new ProfileMatcher({ include: ["**/*.md"], exclude: ["Archive"] });
    expect(m.matches("notes/note.md")).toBe(true);
    expect(m.matches("notes/note.pdf")).toBe(false);
    expect(m.matches("Archive/note.md")).toBe(false);
  });

  it("PRE-EXISTING GLOB WART, pinned so a future change is deliberate", () => {
    // "**/*.md" compiles to a pattern requiring a slash, so it does NOT match
    // a note at the vault root. Nothing to do with folder excludes; noted here
    // because somebody writing this include would quietly not sync root notes.
    const m = new ProfileMatcher({ include: ["**/*.md"], exclude: [] });
    expect(m.matches("root-note.md")).toBe(false);
    expect(m.matches("folder/note.md")).toBe(true);
    // The spelling that does what people mean:
    expect(new ProfileMatcher({ include: ["**"], exclude: [] }).matches("root-note.md")).toBe(true);
  });
});

// The harm this defect actually caused, end to end.
describe("THE HARM: an excluded folder must not be deleted on the other devices", () => {
  const PASSPHRASE = "folder exclude passphrase";
  const KDF = { kdf: "argon2id", version: 1, memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

  async function device(storage: MemoryStorage, id: string, profile: SyncProfile, files: Record<string, string>) {
    const adapter = new MockDataAdapter();
    for (const [path, text] of Object.entries(files)) adapter.setFile(path, text);
    const vault = new ObsidianVault(adapter, profile);
    const engine = await openSyncEngine({
      storage,
      vault,
      passphrase: PASSPHRASE,
      deviceId: id,
      state: new MemoryStateStore(),
      kdfDefaults: KDF,
    });
    return { engine, adapter, vault };
  }

  it("a device that excludes Archive by bare name leaves the others' copies alone", async () => {
    const storage = new MemoryStorage();
    // The desktop carries everything and publishes it.
    const desktop = await device(storage, "dev-desktop", { include: ["**"], exclude: [] }, {
      "Note.md": "shared",
      "Archive/old-1.md": "kept on the desktop",
      "Archive/old-2.md": "kept on the desktop too",
    });
    await desktop.engine.sync();

    // The phone excludes the folder with the spelling a person actually writes.
    const phone = await device(storage, "dev-phone", { include: ["**"], exclude: ["Archive"] }, {
      "Note.md": "shared",
    });
    const report = await phone.engine.sync();

    // Before ADR-0037 the phone read those files as deleted and tombstoned
    // them for everybody. Nothing of the sort may happen.
    expect(report.entries.filter((e) => e.kind === "delete-remote")).toEqual([]);
    expect(report.conflicts).toEqual([]);

    // …and the desktop still has them after syncing again.
    await desktop.engine.sync();
    expect(desktop.adapter.getText("Archive/old-1.md")).toBe("kept on the desktop");
    expect(desktop.adapter.getText("Archive/old-2.md")).toBe("kept on the desktop too");
    // The phone did not quietly download them either — they are not its business.
    expect(phone.adapter.getText("Archive/old-1.md")).toBeNull();
  }, 60_000);
});
