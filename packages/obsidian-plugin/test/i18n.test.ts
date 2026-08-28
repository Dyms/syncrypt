// Localization contract (ADR-0021): language resolution is pure and total,
// and every reason code the engine can emit has a phrasing in every language.

import { describe, expect, it } from "vitest";

import { ReasonCode } from "@syncrypt/core";

import { describeDetection, detectLang, resolveLang, stringsFor, EN_STRINGS } from "../src/i18n.js";
import { deriveSyncState, type SyncStateInput } from "../src/sync-state.js";

describe("language resolution", () => {
  it("no usable source means English", () => {
    expect(detectLang({})).toBe("en");
    expect(detectLang({ storage: null, moment: null })).toBe("en");
    expect(detectLang({ storage: "", moment: "" })).toBe("en");
  });

  it("recognizes Russian, ignores languages we do not speak", () => {
    expect(detectLang({ storage: "ru" })).toBe("ru");
    expect(detectLang({ storage: "RU" })).toBe("ru");
    expect(detectLang({ storage: "ru-RU" })).toBe("ru");
    expect(detectLang({ storage: "zh" })).toBe("en");
    expect(detectLang({ storage: "pt-BR" })).toBe("en");
  });

  it("falls back to moment when localStorage says nothing", () => {
    expect(detectLang({ storage: null, moment: "ru" })).toBe("ru");
    expect(detectLang({ storage: "", moment: "ru-ru" })).toBe("ru");
    // An English UI with a Russian system locale must stay English: neither
    // source claims Russian.
    expect(detectLang({ storage: null, moment: "en" })).toBe("en");
  });

  it("an explicit setting overrides Obsidian's language", () => {
    expect(resolveLang("en", { storage: "ru" })).toBe("en");
    expect(resolveLang("ru", { storage: null })).toBe("ru");
    expect(resolveLang("auto", { storage: "ru" })).toBe("ru");
  });

  it("the diagnostics line shows both sources and the verdict", () => {
    expect(describeDetection({ storage: null, moment: "ru" })).toBe(
      "localStorage: —, moment: ru → ru",
    );
  });
});

describe("translation completeness", () => {
  it("every ReasonCode is phrased in every language, never left in English", () => {
    const en = stringsFor("en");
    const ru = stringsFor("ru");
    for (const reason of Object.values(ReasonCode)) {
      expect(en.reasons[reason], reason).toBeTruthy();
      expect(ru.reasons[reason], reason).toBeTruthy();
      expect(ru.reasons[reason], reason).not.toBe(en.reasons[reason]);
    }
  });

  it("the status view renders in the requested language", () => {
    const input: SyncStateInput = {
      locked: false,
      syncing: false,
      appliedSoFar: 0,
      onLine: true,
      status: { baseGeneration: 3, dirtyFiles: 0 },
      lastOutcome: "applied",
      lastSyncAt: Date.parse("2026-08-22T12:00:00Z"),
      lastError: null,
      conflicts: 0,
      counts: { notes: 1960, attachments: 1078 },
    };
    const ru = deriveSyncState(input, stringsFor("ru").status);
    expect(ru.kind).toBe("synced");
    expect(ru.label).toBe("Syncrypt: синхронизировано ✓");
    expect(ru.tooltip).toContain("заметок 1960, вложений 1078");
    expect(ru.tooltip).toContain("поколение №3");
    // The default stays English, so pure callers and tests are unaffected.
    expect(deriveSyncState(input).label).toBe(EN_STRINGS.status.syncedLabel);
  });
});
