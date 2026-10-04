// ADR-0058. Every engine test in this package believes `MemoryStorage`, and
// nothing held it to the contract a real provider is held to. A double that is
// kinder than the thing it stands in for does not make the engine's tests
// wrong — it makes them silent about exactly the cases providers get wrong.
//
// So the double takes the same suite. It is also the only provider that runs
// it with no backend, no network and no temp directory, which makes it the
// place a contract change is noticed first.

import { describeStorageConformance } from "../src/testing/conformance.js";
import { MemoryStorage } from "../src/testing/index.js";
import type { StoragePort } from "../src/index.js";

describeStorageConformance("memory (the engine's own double)", {
  create: (): Promise<StoragePort> => Promise.resolve(new MemoryStorage()),
  // One page, every time: the double has no pagination to prove, and a page
  // size it does not have must not be claimed.
  listPageSize: 10,
});

describeStorageConformance("memory (universal subset only)", {
  create: (): Promise<StoragePort> =>
    Promise.resolve(new MemoryStorage({ conditionalWrites: false })),
  listPageSize: 10,
});
