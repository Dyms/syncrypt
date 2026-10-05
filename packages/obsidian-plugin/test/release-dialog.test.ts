// ADR-0070 at the plugin: the release dialog shows the storage's kept set and
// hands exactly that set to releaseForgotten; a set that changed meanwhile is
// said out loud and nothing is released.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../src/i18n.js";
import { Modal, Notice, resetStub } from "./support/obsidian-stub.js";
import { engineOf, makeDevice, PASS, S3_DATA, settle, unlock, World } from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const KEYS = ["objects/aa", "objects/bb", "objects/cc", "objects/dd"];

async function open(answer: boolean) {
  const me = await makeDevice(new World(), { ...S3_DATA, autoSync: { enabled: false } });
  await unlock(me.plugin, PASS, true);
  await settle(me.plugin);
  const engine = engineOf(me);
  const real = await engine.status();
  vi.spyOn(engine, "status").mockResolvedValue({ ...real, forgottenObjects: 1 }); // the base: behind
  vi.spyOn(engine, "previewRelease").mockResolvedValue([...KEYS]);
  const release = vi.spyOn(engine, "releaseForgotten");
  let shown = -1;
  vi.spyOn(me.plugin as unknown as { ask(o: unknown): Promise<unknown> }, "ask").mockImplementation(
    (make: unknown) => {
      const modal = (make as (r: (v: boolean) => void) => Modal)(() => undefined);
      shown = (modal as unknown as { kept: number }).kept;
      return Promise.resolve(answer);
    },
  );
  return { me, release, shown: () => shown };
}

describe("the release dialog (ADR-0070)", () => {
  it("shows the storage's count, not the base's", async () => {
    const { me, shown } = await open(false);
    await me.plugin.releaseForgotten();
    expect(shown()).toBe(4);
  });

  it("releases exactly the set it showed", async () => {
    const { me, release } = await open(true);
    release.mockResolvedValue({ released: 4, generation: 9 });
    await me.plugin.releaseForgotten();
    expect(release.mock.calls[0]?.[1]).toEqual(KEYS);
    expect(Notice.shown).toContain(EN_STRINGS.releaseModal.done(4));
  });

  it("says so when the set changed meanwhile", async () => {
    const { me, release } = await open(true);
    release.mockResolvedValue({ released: 0, generation: null, stale: true });
    await me.plugin.releaseForgotten();
    expect(Notice.shown).toContain(EN_STRINGS.releaseModal.changed);
    expect(Notice.shown).not.toContain(EN_STRINGS.releaseModal.raced);
  });
});


