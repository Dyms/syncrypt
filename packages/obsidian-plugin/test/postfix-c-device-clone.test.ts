// POST-FIX REVIEW (slice C): ADR-0069 closes the copied-folder clone only for
// copies made AFTER the upgrade. A folder copied while on beta.12 (the way the
// audit's D4 scenario arises) reaches this build on two installations with
// the same deviceId and no `deviceIdInstalled` flag: both read "an upgrade",
// keep the id, and each saves it into its own installation store — the clone
// is now pinned there, and data.json can no longer fix it.
import { describe, expect, it } from "vitest";

import { resolveDeviceIdentity, type InstallStore } from "../src/device-identity.js";

const store = (): InstallStore & { v: string | null } => {
  const s = { v: null as string | null, load: () => s.v, save: (id: string) => { s.v = id; } };
  return s;
};

describe("two installations of one beta.12 folder copy", () => {
  it("do not share a device ID after upgrading", () => {
    let n = 0;
    const gen = (): string => `fresh-${String(++n)}`;
    const laptop = resolveDeviceIdentity("dev-A", false, store(), gen);
    const desktop = resolveDeviceIdentity("dev-A", false, store(), gen);
    expect(laptop.deviceId).not.toBe(desktop.deviceId);
  });
});
