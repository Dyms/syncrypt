// Collapsible settings sections: the one rule, and the promise that nothing
// fell out of the page while it was being rearranged.

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  browserSectionMemory,
  SECTION_IDS,
  sectionOpen,
  type SectionId,
} from "../src/settings-sections.js";

describe("which sections open", () => {
  it("everything is closed by default — that is the point of the change", () => {
    for (const id of SECTION_IDS) {
      if (id === "storage") continue;
      expect(sectionOpen(id, undefined, false), id).toBe(false);
      expect(sectionOpen(id, undefined, true), id).toBe(false);
    }
  });

  it("an unconfigured vault opens Storage, because a closed page would be a lie", () => {
    expect(sectionOpen("storage", undefined, false)).toBe(true);
    expect(sectionOpen("storage", undefined, true)).toBe(false);
  });

  it("what the user last left wins over both", () => {
    expect(sectionOpen("storage", false, false)).toBe(false);
    expect(sectionOpen("safeSync", true, true)).toBe(true);
  });
});

describe("remembering it", () => {
  it("round-trips through a store", () => {
    const map = new Map<string, string>();
    const memory = browserSectionMemory({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    });
    expect(memory.read("safeSync")).toBeUndefined();
    memory.write("safeSync", true);
    expect(memory.read("safeSync")).toBe(true);
    memory.write("safeSync", false);
    expect(memory.read("safeSync")).toBe(false);
  });

  it("survives a store that is absent, or that throws on every access", () => {
    const absent = browserSectionMemory(undefined);
    expect(absent.read("storage")).toBeUndefined();
    expect(() => { absent.write("storage", true); }).not.toThrow();

    const hostile = browserSectionMemory({
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });
    expect(hostile.read("storage")).toBeUndefined();
    expect(() => { hostile.write("storage", true); }).not.toThrow();
  });
});

describe("the rearrangement lost nothing", () => {
  it("every setting sits in a section, and only status and lock stay loose", async () => {
    const src = await readFile(
      path.resolve(fileURLToPath(import.meta.url), "../../src/settings-tab.ts"),
      "utf8",
    );
    // Two: the sync-status block and the lock/unlock block. Those are what a
    // person opens settings FOR, so they are never behind a fold.
    expect(src.match(/new Setting\(containerEl\)/g)).toHaveLength(2);
    // Every declared section is actually created…
    for (const id of SECTION_IDS) {
      expect(src, id).toContain(`section("${id}"`);
    }
    // …and no heading is left as a bare setHeading() at the top level, which
    // is what the sections replaced.
    expect(src).not.toMatch(/new Setting\(containerEl\)\.setName\([^)]*\)\.setHeading\(\)/);
  });

  it("the sections cover the settings the plugin actually has", async () => {
    const src = await readFile(
      path.resolve(fileURLToPath(import.meta.url), "../../src/settings.ts"),
      "utf8",
    );
    // A crude but honest tripwire: every top-level settings group needs a home.
    const groups: Record<string, SectionId> = {
      language: "interface",
      s3: "storage",
      profile: "profile",
      configSync: "configSync",
      safeSync: "safeSync",
      kdfProfile: "vaultCreation",
      autoSync: "autoSync",
    };
    for (const group of Object.keys(groups)) {
      expect(src, group).toContain(`${group}:`);
    }
    expect(new Set(Object.values(groups)).size).toBe(SECTION_IDS.length - 1); // "devices" holds no settings
  });
});
