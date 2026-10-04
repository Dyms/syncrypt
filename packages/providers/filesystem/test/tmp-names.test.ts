// ADR-0060. A write that is interrupted leaves a temp file behind; both
// adapters in this package write that way, and only one of them knew to skip
// the leftovers. The vault adapter listed them as notes — so a fragment of a
// half-finished download was uploaded to every device under a name ending in
// random characters, and stayed for ever.

import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { VaultPath } from "@syncrypt/core";

import { FilesystemVault } from "../src/index.js";
import { TMP_MARKER, isTmpName, tmpPathFor } from "../src/tmp.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function vaultIn(): Promise<{ vault: FilesystemVault; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "syncrypt-tmpnames-"));
  roots.push(root);
  return { vault: new FilesystemVault(root), root };
}

const listed = async (vault: FilesystemVault): Promise<VaultPath[]> => {
  const out: VaultPath[] = [];
  for await (const p of vault.list()) out.push(p);
  return out;
};

describe("an interrupted write is not a note", () => {
  it("THE LEFTOVER OF A HALF-FINISHED WRITE IS NOT LISTED", async () => {
    const { vault, root } = await vaultIn();
    await vault.write("Notes/Meeting.md", new TextEncoder().encode("the real note"));
    // Exactly what a crash mid-write leaves: the temp name this package picks.
    await writeFile(
      path.join(root, "Notes", `Meeting.md${TMP_MARKER}m1abc`),
      "half a dow",
    );

    expect(await listed(vault)).toEqual(["Notes/Meeting.md"]);
  });

  it("a real note whose name merely contains the words is still a note", async () => {
    // The marker is specific on purpose: it starts with a dot, which no
    // ordinary note name has in that position within a segment.
    const { vault } = await vaultIn();
    await vault.write("Notes/syncrypt-tmp notes.md", new TextEncoder().encode("mine"));
    await vault.write("Notes/about syncrypt.md", new TextEncoder().encode("mine"));
    expect((await listed(vault)).sort()).toEqual([
      "Notes/about syncrypt.md",
      "Notes/syncrypt-tmp notes.md",
    ]);
  });

  it("a completed write leaves nothing behind to skip", async () => {
    const { vault, root } = await vaultIn();
    await vault.write("note.md", new TextEncoder().encode("done"));
    expect((await readdir(root)).filter(isTmpName)).toEqual([]);
    expect(await listed(vault)).toEqual(["note.md"]);
  });
});

describe("the temp name itself", () => {
  it("TWO WRITERS IN THE SAME MILLISECOND DO NOT PICK THE SAME NAME", () => {
    // The vault adapter's name was `${target}.syncrypt-tmp-${Date.now()}`: a
    // CLI run and a plugin sync writing one path in the same millisecond
    // would collide, and one would rename the other's half-written file into
    // place.
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) names.add(tmpPathFor("/x/note.md"));
    expect(names.size).toBe(200);
  });

  it("and is recognizable as one", () => {
    expect(isTmpName(tmpPathFor("/x/note.md"))).toBe(true);
    expect(isTmpName("/x/note.md")).toBe(false);
  });
});
