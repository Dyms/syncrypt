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
  | { kind: "confirm-create"; message: string }
  /** A vault with nothing in it yet: the passphrase cannot be checked; ask again. */
  | { kind: "confirm-unchecked"; message: string };

/**
 * The vault exists — its key parameters are there — but nothing has been
 * published, so there is nothing to decrypt and no way to tell a right
 * passphrase from a typo (ADR-0078). A typo here used to unlock, and the first
 * push encrypted the vault's first manifest under a key no other device has.
 * Thrown by the unlock to make the dialog ask for the passphrase again.
 */
export class UncheckablePassphrase extends Error {
  constructor() {
    super("the vault has nothing published yet; the passphrase cannot be checked");
    this.name = "UncheckablePassphrase";
  }
}

export class UnlockFlow {
  /** The passphrase awaiting its repetition, and why it is asked for twice. */
  private pending: { passphrase: string; why: "create" | "unchecked" } | null = null;

  constructor(
    private readonly open: (
      passphrase: string,
      create: boolean,
      confirmed: boolean,
    ) => Promise<void>,
    private readonly t: Strings,
    /** Where the settings point, as a person reads it. */
    private readonly location: string,
  ) {}

  get creating(): boolean {
    return this.pending?.why === "create";
  }

  async submit(passphrase: string): Promise<UnlockStep> {
    if (this.pending !== null) {
      const first = this.pending;
      this.pending = null;
      if (passphrase !== first.passphrase) {
        return {
          kind: "error",
          message:
            first.why === "create"
              ? this.t.unlockModal.createMismatch
              : this.t.unlockModal.confirmMismatch,
        };
      }
      return first.why === "create"
        ? this.attempt(passphrase, true, false)
        : this.attempt(passphrase, false, true);
    }
    return this.attempt(passphrase, false, false);
  }

  /** Back out of the creation question without creating anything. */
  cancelCreate(): void {
    this.pending = null;
  }

  private async attempt(
    passphrase: string,
    create: boolean,
    confirmed: boolean,
  ): Promise<UnlockStep> {
    try {
      await this.open(passphrase, create, confirmed);
      return { kind: "done" };
    } catch (e) {
      if (!create && isSyncError(e, "VaultAbsent")) {
        this.pending = { passphrase, why: "create" };
        return { kind: "confirm-create", message: this.t.unlockModal.vaultAbsent(this.location) };
      }
      if (!confirmed && e instanceof UncheckablePassphrase) {
        this.pending = { passphrase, why: "unchecked" };
        return {
          kind: "confirm-unchecked",
          message: this.t.unlockModal.uncheckable(this.location),
        };
      }
      return { kind: "error", message: unlockFailureMessage(e, this.t) };
    }
  }
}
