// The unlock dialog's decisions, without the dialog (ADR-0065). Pure — no
// `obsidian` import — so what happens on each answer is tested, not eyeballed.
//
// Unlocking never creates a vault on its own. An empty location used to
// become a new vault in silence: a prefix one letter off, the wrong bucket, a
// fresh device configured by hand — each produced a second, empty vault beside
// the real one, and the startup sync uploaded the whole local vault into it.
// ADR-0050 closed creation over DATA; an empty location has none.
//
// So an empty location is a question: here is where you pointed me, there is
// no vault there — create one? And because the passphrase typed at creation
// becomes the vault's passphrase for good, creating asks for it twice.

import { isSyncError } from "@syncrypt/core";

import type { Strings } from "./i18n.js";
import { unlockFailureMessage } from "./unlock-error.js";

export type UnlockStep =
  | { kind: "done" }
  | { kind: "error"; message: string }
  /** No vault at the location: ask, and wait for the passphrase again. */
  | { kind: "confirm-create"; message: string };

export class UnlockFlow {
  /** The passphrase that met an empty location, awaiting its repetition. */
  private pending: string | null = null;

  constructor(
    private readonly open: (passphrase: string, create: boolean) => Promise<void>,
    private readonly t: Strings,
    /** Where the settings point, as a person reads it. */
    private readonly location: string,
  ) {}

  get creating(): boolean {
    return this.pending !== null;
  }

  async submit(passphrase: string): Promise<UnlockStep> {
    if (this.pending !== null) {
      const first = this.pending;
      this.pending = null;
      if (passphrase !== first) {
        return { kind: "error", message: this.t.unlockModal.createMismatch };
      }
      return this.attempt(passphrase, true);
    }
    return this.attempt(passphrase, false);
  }

  /** Back out of the creation question without creating anything. */
  cancelCreate(): void {
    this.pending = null;
  }

  private async attempt(passphrase: string, create: boolean): Promise<UnlockStep> {
    try {
      await this.open(passphrase, create);
      return { kind: "done" };
    } catch (e) {
      if (!create && isSyncError(e, "VaultAbsent")) {
        this.pending = passphrase;
        return { kind: "confirm-create", message: this.t.unlockModal.vaultAbsent(this.location) };
      }
      return { kind: "error", message: unlockFailureMessage(e, this.t) };
    }
  }
}
