// Post-fix review: ADR-0075 makes a newer build's data.json read-only. Add
// device does not know: saveSettings() returns without writing (no throw), so
// replaceSettings() neither rolls back nor fails, the ticket is announced as
// imported, and connectWithPassphrase → unlock() returns silently.

import { beforeEach, describe, expect, it } from "vitest";

import { createConnectionTicket } from "@syncrypt/crypto";

import { EN_STRINGS } from "../../src/i18n.js";
import { Notice, resetStub } from "../support/obsidian-stub.js";
import { importTicket, makeDevice, PASS, S3_DATA, saved, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("Q: a ticket on a read-only (newer data.json) device", () => {
  it("says 'imported' while nothing was saved and nothing connects", async () => {
    const me = await makeDevice(new World(), { ...S3_DATA, provider: "gdrive", gdrive: { folder: "x" } });
    const s3 = S3_DATA.s3;
    const ticket = await createConnectionTicket({ provider: "s3", ...s3 }, PASS);
    await importTicket(me, ticket, PASS);
    const result = {
      announcedImported: Notice.shown.includes(EN_STRINGS.notices.ticketImported),
      persistedProvider: (saved(me) as unknown as { provider: string }).provider,
      memoryProvider: me.plugin.settings.provider,
      unlocked: me.plugin.isUnlocked(),
    };
    // Before ADR-0081: { announcedImported: true, persistedProvider: "gdrive", memoryProvider: "s3", unlocked: false }
    expect(result.announcedImported).toBe(false);
  });
});
