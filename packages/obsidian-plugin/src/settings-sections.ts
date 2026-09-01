// Which settings sections are open — pure, so the one rule worth stating can
// be tested without Obsidian's runtime.
//
// The tab grew to nine headings and every knob was visible at once, which is
// how a settings page stops being read at all. Everything below the status
// block now lives in a collapsible section, closed by default and remembered
// per device. The exception is the case where a closed page would be a lie: a
// fresh install with no storage configured must not look finished.

export const SECTION_IDS = [
  "interface",
  "storage",
  "devices",
  "profile",
  "configSync",
  "safeSync",
  "vaultCreation",
  "autoSync",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/** Where a device remembers what it had open. Per device; never synced. */
export interface SectionMemory {
  read(id: SectionId): boolean | undefined;
  write(id: SectionId, open: boolean): void;
}

/**
 * Open a section when the user last left it open; otherwise keep it closed —
 * except Storage on a vault that has none, where a page of closed headings
 * would hide the only thing that has to be filled in.
 */
export function sectionOpen(
  id: SectionId,
  remembered: boolean | undefined,
  storageConfigured: boolean,
): boolean {
  if (remembered !== undefined) return remembered;
  return id === "storage" && !storageConfigured;
}

const KEY_PREFIX = "syncrypt:settings-section:";

/**
 * localStorage-backed memory that cannot fail the settings page. Storage can
 * be missing, full, or refused outright (a private window, a hardened
 * browser); losing which sections were open costs a click, so every access is
 * wrapped and a failure simply means "not remembered".
 */
export function browserSectionMemory(
  store: Pick<Storage, "getItem" | "setItem"> | undefined,
): SectionMemory {
  return {
    read(id) {
      try {
        const raw = store?.getItem(KEY_PREFIX + id);
        return raw === null || raw === undefined ? undefined : raw === "1";
      } catch {
        return undefined;
      }
    },
    write(id, open) {
      try {
        store?.setItem(KEY_PREFIX + id, open ? "1" : "0");
      } catch {
        // Not remembering is not an error.
      }
    },
  };
}
