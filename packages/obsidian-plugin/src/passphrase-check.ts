// "Is this passphrase definitely wrong?" — pure, so the answer is tested
// rather than eyeballed (no `obsidian` import; main.ts supplies the ports).
//
// It exists for "Share connection" (ADR-0048): a ticket is encrypted with
// whatever was typed, so a typo produced a ticket that opens into settings
// nobody can unlock, discovered on the other device by someone who cannot fix
// it.
//
// Five rules; the second came with ADR-0060, the third ADR-0063, the fourth
// ADR-0081, the fifth ADR-0082:
//
// 1. Only a definite CryptoAuthError is "wrong". An unreachable bucket says
//    nothing about the passphrase. (It used to be "must not block sharing";
//    see rule 5.)
// 2. It must not WRITE. `openSyncEngine` creates `meta/keyfile-params.json`
//    when the vault has none, and this path passed no `kdfDefaults` — so
//    pressing a button that looks like a check, before the first sync, created
//    the vault's one and only, permanent KDF profile from the cross-device
//    default and silently discarded a desktop-only choice. A vault with no
//    keyfile has no passphrase to be wrong about, so the question is answered
//    before anything is opened.
//
// 3. "This device cannot afford to try" is neither answer (ADR-0063). It is
//    rethrown as KdfUnaffordable: reported as "wrong" it rejected the right
//    passphrase; reported as "not wrong" it would seal a ticket with a
//    passphrase nothing checked — the defect rule 1 exists to prevent.
//
// 4. "Nothing to check against" is neither answer either (ADR-0081, post-fix
//    Q2). A vault with no keyfile, or a keyfile and nothing published, opens
//    with any passphrase; "not wrong" sealed a typo into a ticket that the
//    receiving device takes as confirmed (ADR-0078) and publishes the vault's
//    first generation under — the sharer is locked out of its own vault.
//    Rethrown as NothingToCheck: Share asks for a first sync instead.
//
// 5. Rule 1, revised (ADR-0082): an unreachable bucket still says nothing
//    about the passphrase — so it is not "not wrong" either. It said so, and
//    an offline Share sealed a typo the receiving device then took as
//    confirmed (ADR-0078). Every failure other than "does not decrypt" is
//    rethrown; Share says why it cannot check, and seals nothing.

import type { DeviceId, LogPort, StoragePort, VaultPort } from "@syncrypt/core";
import { isSyncError, openSyncEngine, vaultHasKeyfile } from "@syncrypt/sdk";

export interface PassphraseCheckOptions {
  storage: StoragePort;
  vault: VaultPort;
  storagePrefix: string;
  passphrase: string;
  deviceId: DeviceId;
  log?: LogPort;
  /** ADR-0018 ceiling; mobile clients pass theirs. */
  affordability?: { maxMemoryKiB: number };
}

/** The vault has nothing a passphrase can be checked against (rule 4). */
export class NothingToCheck extends Error {
  constructor() {
    super("nothing published to check the passphrase against");
    this.name = "NothingToCheck";
  }
}

export async function passphraseIsDefinitelyWrong(
  opts: PassphraseCheckOptions,
): Promise<boolean> {
  try {
    if (!(await vaultHasKeyfile(opts.storage, opts.storagePrefix))) throw new NothingToCheck();
    const engine = await openSyncEngine({
      storage: opts.storage,
      vault: opts.vault,
      passphrase: opts.passphrase,
      deviceId: opts.deviceId,
      storagePrefix: opts.storagePrefix,
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.affordability !== undefined ? { affordability: opts.affordability } : {}),
    });
    if ((await engine.verifyAccess()) === null) throw new NothingToCheck();
    return false;
  } catch (e) {
    // Only a definite "does not decrypt" is an answer. Everything else —
    // nothing to check, a KDF this device cannot run, a storage that does not
    // answer — is no answer, and an unchecked passphrase is not sealed into a
    // ticket (rule 5, ADR-0082).
    if (isSyncError(e, "CryptoAuthError")) return true;
    throw e;
  }
}
