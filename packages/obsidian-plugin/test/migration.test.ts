import { describe, expect, it } from "vitest";

import { migrationPreflight } from "../src/migration.js";
import { MockDataAdapter } from "./mock-adapter.js";

function withPluginDir(adapter: MockDataAdapter, id: string): void {
  adapter.folders.add(".obsidian");
  adapter.folders.add(".obsidian/plugins");
  adapter.folders.add(`.obsidian/plugins/${id}`);
}

describe("migration preflight (never auto-fix)", () => {
  it("clean vault → no warnings", async () => {
    const adapter = new MockDataAdapter();
    adapter.folders.add(".obsidian");
    expect(await migrationPreflight(adapter)).toEqual([]);
  });

  it("LiveSync ENABLED → loud warning", async () => {
    const adapter = new MockDataAdapter();
    withPluginDir(adapter, "obsidian-livesync");
    adapter.setFile(".obsidian/community-plugins.json", '["obsidian-livesync","some-theme"]');
    const warnings = await migrationPreflight(adapter);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("obsidian-livesync:enabled");
    expect(warnings[0]?.message).toContain("ENABLED");
    expect(warnings[0]?.message).toContain("disable it");
  });

  it("LiveSync installed but disabled → leftover warning", async () => {
    const adapter = new MockDataAdapter();
    withPluginDir(adapter, "obsidian-livesync");
    adapter.setFile(".obsidian/community-plugins.json", '["some-theme"]');
    const warnings = await migrationPreflight(adapter);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("obsidian-livesync:leftovers");
    expect(warnings[0]?.message).toContain("start clean");
  });

  it("detects other sync systems too (two-sync-systems guard)", async () => {
    const adapter = new MockDataAdapter();
    withPluginDir(adapter, "remotely-save");
    withPluginDir(adapter, "obsidian-git");
    adapter.setFile(".obsidian/community-plugins.json", '["remotely-save"]');
    const codes = (await migrationPreflight(adapter)).map((w) => w.code).sort();
    expect(codes).toEqual(["obsidian-git:leftovers", "remotely-save:enabled"]);
  });

  it("corrupt community-plugins.json degrades to the installed-only check", async () => {
    const adapter = new MockDataAdapter();
    withPluginDir(adapter, "obsidian-livesync");
    adapter.setFile(".obsidian/community-plugins.json", "{not json");
    const warnings = await migrationPreflight(adapter);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("obsidian-livesync:leftovers");
  });

  it("preflight only reads — it never writes or deletes anything", async () => {
    const adapter = new MockDataAdapter();
    withPluginDir(adapter, "obsidian-livesync");
    adapter.setFile(".obsidian/community-plugins.json", '["obsidian-livesync"]');
    const filesBefore = [...adapter.files.keys()].sort();
    const foldersBefore = [...adapter.folders].sort();
    await migrationPreflight(adapter);
    expect([...adapter.files.keys()].sort()).toEqual(filesBefore);
    expect([...adapter.folders].sort()).toEqual(foldersBefore);
  });
});
