// Candidate: FilesystemVault.write's WrittenStat (temp file, before rename)
// must equal what stat() reports for the renamed file — else the cache never
// hits (cost) — and a same-size save right after the write must NOT share it
// — else the cache vouches for the download over the user's save (loss).
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { FilesystemVault } from "../../../providers/filesystem/src/vault.js";

it("WrittenStat matches the renamed file and a later same-size save changes it (real fs)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "r3-ws-"));
  const v = new FilesystemVault(dir);
  let collisions = 0;
  let mismatches = 0;
  for (let i = 0; i < 300; i++) {
    const w = await v.write("n.md", new TextEncoder().encode(`downloaded ${i % 10}`));
    const s = await v.stat("n.md");
    if (s?.size !== w.size || s.mtime !== w.mtime) mismatches++;
    // the user saves immediately, same length, in place
    await fs.writeFile(path.join(dir, "n.md"), `USERSAVED ${i % 10}`);
    const s2 = await v.stat("n.md");
    if (s2 !== null && s2.size === w.size && s2.mtime === w.mtime) collisions++;
  }
  await fs.rm(dir, { recursive: true, force: true });
  expect({ mismatches, collisions }).toEqual({ mismatches: 0, collisions: 0 });
});
