// File history and compare, on the real plugin (RFC-0010): the Safe-Sync dialog
// can open a comparison per line, the history command lists versions and
// restores one as a COPY, and none of it changes what is not asked.

import { beforeEach, describe, expect, it } from "vitest";

import { CompareModal } from "../src/compare-modal.js";
import { ConfirmSyncModal } from "../src/confirm-modal.js";
import { EN_STRINGS } from "../src/i18n.js";
import { HistoryModal } from "../src/history-modal.js";
import { Menu, Modal, Notice, TFile, resetStub } from "./support/obsidian-stub.js";
import {
  engineOf,
  makeDevice,
  PASS,
  S3_DATA,
  settle,
  unlock,
  waitFor,
  World,
  type Device,
} from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const t = EN_STRINGS;
const modalOf = (kind: abstract new (...a: never[]) => unknown): Modal | undefined =>
  [...Modal.opened].reverse().find((m) => m instanceof kind && m.isOpen);

function must<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

interface WorkspaceStub {
  activeFile: { path: string } | null;
  fileMenu: ((menu: Menu, file: unknown) => void)[];
}
const workspace = (d: Device): WorkspaceStub => (d.app as { workspace: WorkspaceStub }).workspace;

/** One device that has synced three edits of note.md (versions differ in length). */
async function withHistory() {
  const world = new World();
  const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
  await unlock(me.plugin, PASS, true);
  await settle(me.plugin);
  for (const body of ["one\n", "one\ntwo\n", "one\ntwo\nthree\n"]) {
    me.adapter.setFile("note.md", body);
    await engineOf(me).sync();
  }
  return { world, me };
}

async function openHistory(me: Device, path = "note.md") {
  const done = (me.plugin as unknown as { fileHistory(p?: string): Promise<void> }).fileHistory(path);
  await waitFor(() => modalOf(HistoryModal) !== undefined, "the history window");
  return { modal: must(modalOf(HistoryModal), "history window"), done };
}

describe("File history command", () => {
  it("is registered, and offered in a file's context menu but not a folder's", async () => {
    const { me } = await withHistory();
    const commands = (me.plugin as unknown as { commands: { id: string; name: string }[] }).commands;
    expect(commands.find((c) => c.id === "file-history")?.name).toBe(t.commands.fileHistory);

    const handlers = workspace(me).fileMenu;
    expect(handlers).toHaveLength(1);
    const forFile = new Menu();
    must(handlers[0])(forFile, new TFile("note.md"));
    expect(forFile.items.map((i) => i.title)).toEqual([t.historyModal.menuItem]);
    const forFolder = new Menu();
    must(handlers[0])(forFolder, { path: "some/folder" });
    expect(forFolder.items).toEqual([]);
  });

  it("lists the versions, newest first, with the current one marked", async () => {
    const { me } = await withHistory();
    const { modal } = await openHistory(me);
    const text = modal.contentEl.textDeep();
    expect(modal.titleEl.text).toBe(t.historyModal.title("note.md"));
    expect(text.split(t.historyModal.current)).toHaveLength(2); // exactly one current
    expect(text.split(t.historyModal.earlier)).toHaveLength(3); // two earlier
    // "What changed" has a newer neighbour only for the earlier ones.
    expect(modal.contentEl.buttons().filter((b) => b.text === t.historyModal.whatChanged)).toHaveLength(2);
    modal.close();
  });

  it("restores a version as a COPY and leaves the file alone", async () => {
    const { me } = await withHistory();
    const { modal, done } = await openHistory(me);
    const restores = modal.contentEl.buttons().filter((b) => b.text === t.historyModal.restore);
    must(restores[1]).click(); // the middle one: "one\ntwo\n"
    await waitFor(() => [...me.adapter.files.keys()].some((k) => k.includes("restored from")), "the copy");
    const copy = must([...me.adapter.files.keys()].find((k) => k.includes("restored from")));
    expect(copy).toMatch(/^note \(restored from \d{4}-\d{2}-\d{2}\)\.md$/);
    expect(me.adapter.getText(copy)).toBe("one\ntwo\n");
    expect(me.adapter.getText("note.md")).toBe("one\ntwo\nthree\n"); // untouched
    expect(Notice.shown).toContain(t.historyModal.restored(copy));

    // A second restore never lands on the first copy.
    must(restores[1]).click();
    await waitFor(() => [...me.adapter.files.keys()].filter((k) => k.includes("restored from")).length === 2, "second copy");
    expect(me.adapter.getText(copy)).toBe("one\ntwo\n");
    modal.close();
    await done;
  });

  it("compares a version with this device, and one version with the next", async () => {
    const { me } = await withHistory();
    const { modal } = await openHistory(me);
    const compareLocal = modal.contentEl.buttons().filter((b) => b.text === t.historyModal.compareLocal);
    must(compareLocal[2]).click(); // the oldest: "one\n" against this device's "one\ntwo\nthree\n"
    await waitFor(() => modalOf(CompareModal)?.contentEl.textDeep().includes("+") === true, "the comparison");
    const view = must(modalOf(CompareModal)).contentEl.textDeep();
    expect(must(modalOf(CompareModal)).titleEl.text).toBe(t.compareModal.title("note.md"));
    // Left is this device, right is the stored version: two lines exist only on the left.
    expect(view).toContain("− two");
    expect(view).toContain("− three");
    expect(view).toContain(t.compareModal.summary(0, 2));
    must(modalOf(CompareModal)).close();

    const changed = modal.contentEl.buttons().filter((b) => b.text === t.historyModal.whatChanged);
    must(changed[0]).click(); // "one\ntwo\n" → "one\ntwo\nthree\n"
    await waitFor(() => modalOf(CompareModal)?.contentEl.textDeep().includes("three") === true, "what changed");
    expect(must(modalOf(CompareModal)).contentEl.textDeep()).toContain("+ three");
    must(modalOf(CompareModal)).close();
    modal.close();
  });

  it("says so when storage holds nothing for the file, and opens no window", async () => {
    const { me } = await withHistory();
    await (me.plugin as unknown as { fileHistory(p?: string): Promise<void> }).fileHistory("never-synced.md");
    expect(Notice.shown).toContain(t.historyModal.empty);
    expect(modalOf(HistoryModal)).toBeUndefined();
  });

  it("with no file open, says to open one", async () => {
    const { me } = await withHistory();
    workspace(me).activeFile = null;
    await (me.plugin as unknown as { fileHistory(p?: string): Promise<void> }).fileHistory();
    expect(Notice.shown).toContain(t.historyModal.noActiveFile);
  });

  it("uses the open file when no path is given", async () => {
    const { me } = await withHistory();
    workspace(me).activeFile = { path: "note.md" };
    const done = (me.plugin as unknown as { fileHistory(p?: string): Promise<void> }).fileHistory();
    await waitFor(() => modalOf(HistoryModal) !== undefined, "the history window");
    must(modalOf(HistoryModal)).close();
    await done;
  });

  it("a locked device asks to unlock instead of opening the history", async () => {
    const { me } = await withHistory();
    me.plugin.lock();
    await (me.plugin as unknown as { fileHistory(p?: string): Promise<void> }).fileHistory("note.md");
    expect(modalOf(HistoryModal)).toBeUndefined();
  });

  it("locking closes the history window and its comparison, and nothing is restored afterwards", async () => {
    const { me } = await withHistory();
    const { modal, done } = await openHistory(me);
    must(modal.contentEl.buttons().find((b) => b.text === t.historyModal.compareLocal)).click();
    await waitFor(() => modalOf(CompareModal) !== undefined, "the comparison");
    me.plugin.lock();
    await done;
    expect(modal.isOpen).toBe(false);
    expect(modalOf(CompareModal)).toBeUndefined();
    expect([...me.adapter.files.keys()].some((k) => k.includes("restored from"))).toBe(false);
  });

  it("the history of a deleted file says it is deleted and still lists its last version", async () => {
    const { me } = await withHistory();
    await me.adapter.remove("note.md");
    await engineOf(me).sync();
    const { modal } = await openHistory(me);
    expect(modal.contentEl.textDeep()).toContain(t.historyModal.deleted);
    expect(modal.contentEl.buttons().filter((b) => b.text === t.historyModal.restore).length).toBeGreaterThan(0);
    modal.close();
  });
});

// -- the Safe-Sync dialog --------------------------------------------------------

const STRICT = { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 };

/** Another device deletes a, b and rewrites c; this one must confirm. */
async function confirming() {
  const world = new World();
  const other = await makeDevice(world, { ...S3_DATA, deviceId: "dev-other" });
  other.adapter.setFile("a.md", "alpha line\n");
  other.adapter.setFile("b.md", "bravo line\n");
  other.adapter.setFile("c.md", "charlie\nsecond\n");
  await unlock(other.plugin, PASS, true);
  await settle(other.plugin);
  const me = await makeDevice(world, { ...S3_DATA, safeSync: STRICT, autoSync: { enabled: false } });
  await unlock(me.plugin);
  await settle(me.plugin);
  await other.adapter.remove("a.md");
  await other.adapter.remove("b.md");
  other.adapter.setFile("c.md", "charlie\nSECOND\nthird\n");
  await engineOf(other).sync();
  return { me, other };
}

describe("The Safe-Sync dialog offers a comparison per line", () => {
  it("shows what a deletion would remove, and what an overwrite would change", async () => {
    const { me } = await confirming();
    const sync = me.plugin.syncNow("manual");
    await waitFor(() => modalOf(ConfirmSyncModal) !== undefined, "the confirmation");
    const dialog = must(modalOf(ConfirmSyncModal), "confirmation dialog");
    expect(dialog.contentEl.textDeep()).toContain(t.confirmModal.compareHint);
    const rows = dialog.contentEl.all().filter((e) => e.tag === "div" && e.children.some((c) => c.tag === "code"));
    expect(rows.length).toBe(3);
    const rowFor = (path: string) => must(rows.find((r) => r.children[0]?.text === path), path);

    // A deletion: the local file against nothing.
    rowFor("a.md").button(t.confirmModal.compare).click();
    await waitFor(() => modalOf(CompareModal)?.contentEl.textDeep().includes("alpha") === true, "deletion view");
    expect(must(modalOf(CompareModal)).contentEl.textDeep()).toContain("− alpha line");
    must(modalOf(CompareModal)).close();

    // An overwrite: what is here against what would replace it.
    rowFor("c.md").button(t.confirmModal.compare).click();
    await waitFor(() => modalOf(CompareModal)?.contentEl.textDeep().includes("third") === true, "overwrite view");
    const view = must(modalOf(CompareModal)).contentEl.textDeep();
    expect(view).toContain("− second");
    expect(view).toContain("+ SECOND");
    expect(view).toContain("+ third");
    must(modalOf(CompareModal)).close();

    // Looking decided nothing: the dialog is still open and nothing was applied.
    expect(dialog.isOpen).toBe(true);
    expect(me.adapter.getText("a.md")).toBe("alpha line\n");
    expect(me.adapter.getText("c.md")).toBe("charlie\nsecond\n");

    dialog.contentEl.button(t.confirmModal.cancel).click();
    await sync;
    expect(me.adapter.getText("a.md")).toBe("alpha line\n"); // cancelled: nothing applied
  });
});
