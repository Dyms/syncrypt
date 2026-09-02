import { describe, expect, it } from "vitest";

import { configPaths } from "../src/config-sync.js";
import { EN_STRINGS } from "../src/i18n.js";
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

// ADR-0046. The vault decides what its config folder is called (ADR-0032), and
// this check — the only thing standing between a user and two sync engines
// writing the same vault — was written against the constant ".obsidian".
describe("a vault whose config folder is not called .obsidian", () => {
  const paths = configPaths(".obsidian-work");

  function vaultWith(id: string, enabled: boolean): MockDataAdapter {
    const adapter = new MockDataAdapter();
    adapter.folders.add(".obsidian-work");
    adapter.folders.add(".obsidian-work/plugins");
    adapter.folders.add(`.obsidian-work/plugins/${id}`);
    adapter.setFile(".obsidian-work/community-plugins.json", JSON.stringify(enabled ? [id] : []));
    return adapter;
  }

  it("is checked, instead of silently reporting nothing", async () => {
    const warnings = await migrationPreflight(vaultWith("obsidian-livesync", true), EN_STRINGS, paths);
    expect(warnings.map((w) => w.code)).toEqual(["obsidian-livesync:enabled"]);
  });

  it("finds leftovers there too", async () => {
    const warnings = await migrationPreflight(vaultWith("remotely-save", false), EN_STRINGS, paths);
    expect(warnings.map((w) => w.code)).toEqual(["remotely-save:leftovers"]);
  });

  it("still checks the DEFAULT folder as well, in case the name is wrong", async () => {
    // Belt and braces, the same way hardExcluded does it: if the configured
    // name is ever wrong, the classic location is still examined.
    const adapter = new MockDataAdapter();
    adapter.folders.add(".obsidian");
    adapter.folders.add(".obsidian/plugins");
    adapter.folders.add(".obsidian/plugins/obsidian-git");
    adapter.setFile(".obsidian/community-plugins.json", '["obsidian-git"]');
    const warnings = await migrationPreflight(adapter, EN_STRINGS, paths);
    expect(warnings.map((w) => w.code)).toEqual(["obsidian-git:enabled"]);
  });

  it("does not report the same plugin twice when both folders have it", async () => {
    const adapter = vaultWith("obsidian-livesync", true);
    adapter.folders.add(".obsidian");
    adapter.folders.add(".obsidian/plugins");
    adapter.folders.add(".obsidian/plugins/obsidian-livesync");
    const warnings = await migrationPreflight(adapter, EN_STRINGS, paths);
    expect(warnings).toHaveLength(1);
  });
});

describe("the preflight is a warning mechanism, not a gate", () => {
  it("an adapter that throws does not take an unlock down with it", async () => {
    // It runs inside unlock's try, after verifyAccess has already proved the
    // vault open. An error here used to discard that (ADR-0046).
    const adapter = new MockDataAdapter();
    adapter.exists = () => Promise.reject(new Error("adapter is having a day"));
    await expect(
      migrationPreflight(adapter, EN_STRINGS).catch(() => []),
    ).resolves.toEqual([]);
  });
});
