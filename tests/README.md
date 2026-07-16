# Tests

Cross-package and end-to-end tests. Unit tests live inside each package.

- **Planner**: golden fixtures + property-based tests asserting the core
  invariants (no data loss, no silent overwrite).
- **Provider conformance**: one suite run against every `StorageProvider`.
- **End-to-end**: three-device convergence over fuzzed edit/delete/rename runs.
