// The SDK's public names are a contract after 1.0. A name that says one thing
// and means another is the one kind that cannot be fixed later, so it is held
// here: `MOBILE_KDF_PRESET` was an alias of the cross-device preset with no
// reader and a name that promised something else (ADR-0087).

import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

describe("public surface", () => {
  it("has no mobile-named KDF preset: the one default is cross-device", () => {
    expect(Object.keys(sdk)).not.toContain("MOBILE_KDF_PRESET");
    expect(sdk.CROSS_DEVICE_KDF_PRESET.memoryKiB).toBe(32768);
    expect(sdk.DESKTOP_KDF_PRESET.memoryKiB).toBeGreaterThan(sdk.CROSS_DEVICE_KDF_PRESET.memoryKiB);
  });
});
