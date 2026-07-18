// RFC-0006 conformance for the filesystem provider, in both capability modes.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describeStorageConformance } from "@syncrypt/core/testing/conformance";
import type { StoragePort } from "@syncrypt/core";

import { FilesystemStorage } from "../src/index.js";

const roots = new WeakMap<StoragePort, string>();

function harness(conditionalWrites: boolean) {
  return {
    async create(): Promise<StoragePort> {
      const root = await mkdtemp(path.join(tmpdir(), "syncrypt-conformance-"));
      const storage = new FilesystemStorage(root, { conditionalWrites });
      roots.set(storage, root);
      return storage;
    },
    async destroy(storage: StoragePort): Promise<void> {
      const root = roots.get(storage);
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    },
  };
}

describeStorageConformance("filesystem (conditional writes)", harness(true));
describeStorageConformance("filesystem (universal subset only)", harness(false));
