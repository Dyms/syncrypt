// The comparison exists because the naive one is wrong in the one case that
// will actually happen on somebody's devices.

import { describe, expect, it } from "vitest";

import { compareVersions, versionSkew } from "../src/index.js";

describe("compareVersions", () => {
  it("gets beta.9 vs beta.10 right — a string compare does not", () => {
    // The trap, and the reason this module exists: these two are the versions
    // most likely to be running side by side on somebody's devices.
    const versions: Record<"older" | "newer", string> = {
      older: "1.0.0-beta.9",
      newer: "1.0.0-beta.10",
    };
    const { older, newer } = versions;
    expect(older < newer).toBe(false); // what a string comparison believes
    expect(compareVersions(older, newer)).toBe(-1);
    expect(compareVersions(newer, older)).toBe(1);
  });

  it("orders releases by their numbers", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("a release outranks its own prereleases (semver §11)", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.10")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });

  it("orders prerelease identifiers the way semver says", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-rc.1")).toBe(-1);
  });

  it("answers null rather than guessing at something that is not a version", () => {
    for (const bad of ["", "v1.0.0", "1.0", "next", "1.0.0.0", "abc"]) {
      expect(compareVersions(bad, "1.0.0"), bad).toBeNull();
      expect(compareVersions("1.0.0", bad), bad).toBeNull();
    }
  });
});

describe("versionSkew", () => {
  it("names which side is stale", () => {
    expect(versionSkew("1.0.0-beta.10", "1.0.0-beta.10")).toBe("same");
    expect(versionSkew("1.0.0-beta.10", "1.0.0-beta.9")).toBe("client-behind");
    expect(versionSkew("1.0.0-beta.9", "1.0.0-beta.10")).toBe("client-ahead");
  });

  it("a manifest with no recorded writer means something OLD wrote it", () => {
    // Versions were not recorded before this existed, so absence is not
    // "unknown" — it is evidence of a client that predates the record.
    expect(versionSkew(undefined, "1.0.0-beta.10")).toBe("client-ahead");
    expect(versionSkew("", "1.0.0-beta.10")).toBe("client-ahead");
  });

  it("says nothing when it cannot tell", () => {
    expect(versionSkew("1.0.0-beta.10", undefined)).toBe("unknown");
    expect(versionSkew("some-fork-build", "1.0.0-beta.10")).toBe("unknown");
  });
});
