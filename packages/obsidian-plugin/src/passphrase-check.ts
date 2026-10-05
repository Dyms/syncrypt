// "Is this passphrase definitely wrong?" — pure, so the answer is tested
// rather than eyeballed (no `obsidian` import; main.ts supplies the ports).
//
// It exists for "Share connection" (ADR-0048): a ticket is encrypted with
// whatever was typed, so a typo produced a ticket that opens into settings
// nobody can unlock, discovered on the other device by someone who cannot fix
// it.
//
// Three rules; the second was missing until ADR-0060, the third until ADR-0063:
//
// 1. Only a definite CryptoAuthError is "wrong". An unreachable bucket says
//    nothing about the passphrase and must not block sharing.
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

export async function passphraseIsDefinitelyWrong(
  opts: PassphraseCheckOptions,
): Promise<boolean> {
  try {
    if (!(await vaultHasKeyfile(opts.storage, opts.storagePrefix))) return false;
    const engine = await openSyncEngine({
      storage: opts.storage,
      vault: opts.vault,
      passphrase: opts.passphrase,
      deviceId: opts.deviceId,
      storagePrefix: opts.storagePrefix,
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.affordability !== undefined ? { affordability: opts.affordability } : {}),
    });
    await engine.verifyAccess();
    return false;
  } catch (e) {
    if (isSyncError(e, "KdfUnaffordable")) throw e;
    return isSyncError(e, "CryptoAuthError");
  }
}
