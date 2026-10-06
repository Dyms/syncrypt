// ADR-0069: the device ID belongs to the installation, not to the folder.
//
// It used to live only in data.json, inside the vault folder. Copying the
// folder to a second computer — the ordinary way to set one up, or a backup
// restored onto another machine — copied the identity with it. Two devices
// with one ID publish the SAME manifest key for the same generation; on a
// backend without conditional writes (WebDAV) the second overwrites the first
// and the fork rule (ADR-0006 §4) cannot see a fork that has one name. One
// device's edit was lost without a trace (audit №4, A1/D4).
//
// Obsidian keeps a vault-scoped localStorage per installation (since 1.8.7).
// A copied folder opened elsewhere is a new vault there, with nothing in it.

/** Where this installation keeps its own copy of the ID. Null: not supported. */
export interface InstallStore {
  load(): string | null;
  save(id: string): void;
}

export interface DeviceIdentity {
  deviceId: string;
  /** data.json says an installation has taken ownership of the ID. */
  installed: boolean;
  /** This installation found a folder another one owns: a new ID was made. */
  copied: boolean;
}

export const DEVICE_ID_KEY = "syncrypt-device-id";

/**
 * Decide this device's ID.
 *
 * - The installation's own ID, when it has one, wins — over whatever data.json
 *   says (a data.json that another tool keeps in step between two machines
 *   must not make them share an ID, nor flip it on every launch).
 * - No installation ID, and data.json never handed one over: an upgrade from a
 *   build that kept it only in data.json — or one of two installations that
 *   already share a copied folder from that build, which looks the same and
 *   is the defect this fixes (post-fix review, R2; ADR-0081). A NEW ID, in
 *   silence: it is not a copy to announce, and a new ID orphans nothing — the
 *   base still names the old one, which `baseFor` finds as the winner of its
 *   own generation.
 * - No installation ID, and data.json says one was handed over: this folder was
 *   copied from another installation (or this one's local data was wiped). A
 *   new ID. The base stays: with distinct IDs a shared starting point is two
 *   devices that synced the same generation, which the fork rule handles.
 * - No support for installation storage (Obsidian before 1.8.7): as before.
 */
export function resolveDeviceIdentity(
  fromData: string | undefined,
  installed: boolean,
  store: InstallStore | null,
  generate: () => string,
): DeviceIdentity {
  if (store === null) {
    return { deviceId: fromData ?? generate(), installed, copied: false };
  }
  const own = store.load();
  if (own !== null && own !== "") return { deviceId: own, installed: true, copied: false };
  if (installed) {
    const fresh = generate();
    store.save(fresh);
    return { deviceId: fresh, installed: true, copied: true };
  }
  const fresh = generate();
  store.save(fresh);
  return { deviceId: fresh, installed: true, copied: false };
}
