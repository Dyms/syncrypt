// ADR-0085: every manifest carries its id (a digest of its content) and the
// ids of the manifests it descends from; a base is trusted only on that line.
import { describe, expect, it } from "vitest";

import { LINEAGE_DEPTH, parseManifest, serializeManifest } from "../../src/manifest.js";
import { MemoryStorage } from "../../src/testing/index.js";
import type { Manifest } from "../../src/types.js";
import { device, write } from "../postfix-3/harness.js";

const dec = new TextDecoder();

async function manifests(storage: MemoryStorage): Promise<Manifest[]> {
  const out: Manifest[] = [];
  for (const k of storage.keys().filter((x) => x.startsWith("manifests/")).sort()) {
    out.push(JSON.parse(dec.decode(await storage.get(k))) as Manifest);
  }
  return out;
}

describe("lineage (ADR-0085)", () => {
  it("each publish names its parent, newest first", async () => {
    const storage = new MemoryStorage();
    const a = device(storage, "dev-a");
    for (let i = 0; i < 4; i++) {
      write(a, "n.md", `v${"x".repeat(i)}`);
      await a.engine.sync();
    }
    const ms = await manifests(storage); // IdentityCrypto: plaintext
    expect(ms).toHaveLength(4);
    for (const m of ms) expect(m.id).toMatch(/^[0-9a-f]{32}$/);
    expect(ms[0]?.ancestors).toBeUndefined();
    expect(ms[3]?.ancestors).toEqual([ms[2]?.id, ms[1]?.id, ms[0]?.id]);
  });

  it("a malformed id or line is corrupt, not ignored", () => {
    const base = { version: 1, generation: 2, device: "dev-a", updatedAt: 1, files: {}, tombstones: {} };
    const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
    expect(() => parseManifest(enc({ ...base, id: "nothex" }))).toThrow(/invalid id/);
    expect(() => parseManifest(enc({ ...base, ancestors: ["zz"] }))).toThrow(/invalid ancestors/);
    expect(() =>
      parseManifest(enc({ ...base, ancestors: Array.from({ length: LINEAGE_DEPTH + 1 }, () => "a".repeat(32)) })),
    ).toThrow(/invalid ancestors/);
    const ok = parseManifest(enc({ ...base, id: "a".repeat(32), ancestors: ["b".repeat(32)] }));
    expect(ok.id).toBe("a".repeat(32));
    expect(ok.ancestors).toEqual(["b".repeat(32)]);
    // Round-trips (the base in the state file keeps its id).
    expect(parseManifest(serializeManifest(ok))).toEqual(ok);
  });

  it("an honest device that fell far behind still syncs cleanly (no false 'off the line')", async () => {
    const storage = new MemoryStorage();
    const a = device(storage, "dev-a");
    const b = device(storage, "dev-b");
    write(a, "n.md", "v0");
    await a.engine.sync();
    await b.engine.sync();
    for (let i = 0; i < 20; i++) {
      write(a, "n.md", `v${String(i + 1)} ${"x".repeat(i)}`);
      await a.engine.sync();
    }
    const r = await b.engine.sync();
    expect(r.conflicts).toEqual([]);
    expect(b.vault.getText("n.md")).toBe(a.vault.getText("n.md"));
    expect(b.log.lines.join(",")).not.toMatch(/base-off-line/);
  });
});
