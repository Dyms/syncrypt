import { describe, expect, it } from "vitest";

import { DEFAULT_PROFILE, ProfileMatcher } from "../src/profile.js";
import { ObsidianVault, SYNC_TRASH_DIR } from "../src/vault-adapter.js";
import { AdapterStateStore } from "../src/state-store.js";
import { MockDataAdapter } from "./mock-adapter.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function listAll(vault: ObsidianVault): Promise<string[]> {
  const out: string[] = [];
  for await (const p of vault.list()) out.push(p);
  return out;
}

describe("ObsidianVault (VaultPort over DataAdapter)", () => {
  it("lists files recursively, excluding dot-folders, trash, and profile excludes", async () => {
    const adapter = new MockDataAdapter();
    adapter.setFile("note.md", "a");
    adapter.setFile("dir/deep/nested.md", "b");
    adapter.setFile(".obsidian/config.json", "hidden");
    adapter.setFile(`${SYNC_TRASH_DIR}/old.md`, "trashed");
    adapter.setFile(".hidden/secret.md", "hidden");
    adapter.setFile("dir/.DS_Store", "junk");
    const vault = new ObsidianVault(adapter, DEFAULT_PROFILE);
    expect(await listAll(vault)).toEqual(["dir/deep/nested.md", "note.md"]);
  });

  it("normalizes NFD paths from the adapter to NFC (ADR-0007, macOS)", async () => {
    const adapter = new MockDataAdapter();
    const nfd = "resumé.md"; // e + combining acute, as APFS may report
    adapter.setFile(nfd, "x");
    const vault = new ObsidianVault(adapter, DEFAULT_PROFILE);
    const listed = await listAll(vault);
    expect(listed).toEqual(["resumé.md".normalize("NFC")]);
    expect(listed[0]?.normalize("NFD")).toBe(nfd);
  });

  it("round-trips read/write and creates parent folders", async () => {
    const adapter = new MockDataAdapter();
    const vault = new ObsidianVault(adapter, DEFAULT_PROFILE);
    await vault.write("new/dir/file.md", enc("content"));
    expect(adapter.getText("new/dir/file.md")).toBe("content");
    expect(new TextDecoder().decode(await vault.read("new/dir/file.md"))).toBe("content");
    const stat = await vault.stat("new/dir/file.md");
    expect(stat?.size).toBe(7);
  });

  it("trash() moves into sync-trash (never hard-deletes) and keeps prior versions", async () => {
    const adapter = new MockDataAdapter();
    adapter.setFile("dir/gone.md", "v1");
    const vault = new ObsidianVault(adapter, DEFAULT_PROFILE);

    await vault.trash("dir/gone.md");
    expect(adapter.getText("dir/gone.md")).toBeNull();
    expect(adapter.getText(`${SYNC_TRASH_DIR}/dir/gone.md`)).toBe("v1");

    // Same path trashed again later must NOT overwrite the first copy.
    adapter.setFile("dir/gone.md", "v2");
    await vault.trash("dir/gone.md");
    expect(adapter.getText(`${SYNC_TRASH_DIR}/dir/gone.md`)).toBe("v1");
    expect(adapter.getText(`${SYNC_TRASH_DIR}/dir/gone.md.1`)).toBe("v2");

    await vault.trash("dir/gone.md"); // already gone — idempotent
  });

  it("read of a missing file rejects VaultFileNotFound", async () => {
    const vault = new ObsidianVault(new MockDataAdapter(), DEFAULT_PROFILE);
    await expect(vault.read("nope.md")).rejects.toMatchObject({
      code: "VaultFileNotFound",
    });
  });

  it("write verifies the read-back and fails LOUD on corruption (ADR-0017)", async () => {
    const adapter = new MockDataAdapter();
    // A byzantine adapter that truncates every write.
    const original = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data) => original(path, data.slice(0, 2));
    const vault = new ObsidianVault(adapter, DEFAULT_PROFILE);
    await expect(vault.write("note.md", enc("full content"))).rejects.toMatchObject({
      code: "VaultWriteFailed",
    });
    await expect(vault.write("note.md", enc("full content"))).rejects.toThrow(
      /write verification failed/,
    );
  });
});

describe("ProfileMatcher", () => {
  it("matches includes minus excludes with **, * and ?", () => {
    const m = new ProfileMatcher({
      include: ["**"],
      exclude: ["Attachments/**", "*.tmp", "draft-?.md"],
    });
    expect(m.matches("note.md")).toBe(true);
    expect(m.matches("dir/note.md")).toBe(true);
    expect(m.matches("Attachments/img.png")).toBe(false);
    expect(m.matches("scratch.tmp")).toBe(false);
    expect(m.matches("dir/scratch.tmp")).toBe(true); // "*.tmp" is root-anchored
    expect(m.matches("draft-1.md")).toBe(false);
    expect(m.matches("draft-10.md")).toBe(true); // "?" is exactly one character
  });

  it("include patterns narrow the sync scope", () => {
    const m = new ProfileMatcher({ include: ["Projects/**", "*.md"], exclude: [] });
    expect(m.matches("Projects/plan.md")).toBe(true);
    expect(m.matches("top.md")).toBe(true);
    expect(m.matches("Daily/2026.md")).toBe(false);
  });
});

describe("AdapterStateStore (ADR-0011)", () => {
  it("round-trips the state blob and creates the plugin folder", async () => {
    const adapter = new MockDataAdapter();
    adapter.folders.add(".obsidian");
    const store = new AdapterStateStore(adapter);
    expect(await store.load()).toBeNull();
    await store.save(enc('{"version":1}'));
    expect(new TextDecoder().decode((await store.load()) ?? new Uint8Array())).toBe(
      '{"version":1}',
    );
  });
});
