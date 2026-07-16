# Manual Recovery (decrypt without Syncrypt)

This is the concrete proof of **"user owns the data"**: given your passphrase and
the documented on-storage format, you can decrypt your manifest and every file
with a short, dependency-light script — no Syncrypt install required.

> Status: **shipped and tested (M2).** The crypto format
> ([RFC-0005](../rfc/RFC-0005-Encryption-Model.md)) is versioned; the scripts
> below target crypto format **version 1**. The Node script
> ([`recover.mjs`](./recover.mjs)) is exercised in CI against a real encrypted
> vault on every test run.

## What you need

- Your **passphrase**.
- A copy of the storage prefix for your vault, containing:
  - `meta/keyfile-params.json` — non-secret Argon2id salt + parameters,
  - `manifests/` — encrypted manifest generation objects,
  - `objects/` — encrypted file blobs.

Download these with any S3 client (`aws s3 sync`, `rclone`, the provider's web UI…).

## Object blob format (v1)

Every encrypted blob (manifest or file) is:

```
offset  bytes  field
0       4      magic   = "SYNC"
4       1      version = 1
5       1      alg     = 1 (AES-256-GCM)
6       12     nonce   (random per encryption)
18      N      ciphertext
18+N    16     GCM tag
```

The 18-byte header `magic|version|alg|nonce` is the GCM **AAD**.

## Key derivation (v1)

```
MasterKey = Argon2id(passphrase, salt, memoryKiB, iterations, parallelism)  → 32 bytes
ContentKey  = HKDF-SHA256(MasterKey, salt=∅, info="syncrypt/content",  len=32)
ManifestKey = HKDF-SHA256(MasterKey, salt=∅, info="syncrypt/manifest", len=32)
```

The Argon2id `salt` in `keyfile-params.json` is **standard base64** (with
padding). HKDF uses an empty salt (RFC 5869 default). You do not need the Name
key for recovery: the decrypted manifest already lists each file's `objectKey`.

## Picking the newest manifest

Manifests are named `manifests/<zero-padded generation>-<deviceId>.json`. Take
the highest generation; in the rare case two devices share it (a fork), take
the **smallest deviceId** — that is the canonical winner (ADR-0006).

## Option A — Node.js script (tested in CI)

[`recover.mjs`](./recover.mjs) needs Node ≥ 20 and one package:

```bash
npm install hash-wasm
SYNCRYPT_PASSPHRASE='your passphrase' node recover.mjs ./downloaded-prefix ./restored
```

## Option B — Python 3 script

```python
#!/usr/bin/env python3
# Dependencies: pip install argon2-cffi cryptography
import base64, json, os, re, sys
from argon2.low_level import hash_secret_raw, Type
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."      # folder with meta/, manifests/, objects/
OUT  = sys.argv[2] if len(sys.argv) > 2 else "restored"
passphrase = os.environ["SYNCRYPT_PASSPHRASE"].encode()  # avoid shell history

def derive_keys(passphrase, p):
    assert p["kdf"] == "argon2id" and p["version"] == 1, "unsupported keyfile-params"
    mk = hash_secret_raw(
        secret=passphrase, salt=base64.b64decode(p["salt"]),   # salt is standard base64
        time_cost=p["iterations"], memory_cost=p["memoryKiB"],
        parallelism=p["parallelism"], hash_len=32, type=Type.ID)
    def sub(info): return HKDF(SHA256(), 32, None, info.encode()).derive(mk)
    return sub("syncrypt/content"), sub("syncrypt/manifest")

def decrypt(blob, key):
    magic, ver, alg = blob[:4], blob[4], blob[5]
    assert magic == b"SYNC" and ver == 1 and alg == 1, "unsupported blob"
    nonce, aad = blob[6:18], blob[:18]
    ct_tag = blob[18:]
    return AESGCM(key).decrypt(nonce, ct_tag, aad)

params = json.load(open(os.path.join(ROOT, "meta", "keyfile-params.json")))
content_key, manifest_key = derive_keys(passphrase, params)

# newest manifest = highest generation; on a fork, smallest deviceId wins (ADR-0006)
refs = [(int(m.group(1)), m.group(2), n)
        for n in os.listdir(os.path.join(ROOT, "manifests"))
        if (m := re.match(r"^(\d+)-(.+)\.json$", n))]
top = max(g for g, _, _ in refs)
newest = min((r for r in refs if r[0] == top), key=lambda r: r[1])[2]
manifest = json.loads(decrypt(open(os.path.join(ROOT, "manifests", newest), "rb").read(),
                              manifest_key))

for path, entry in manifest["files"].items():
    blob = open(os.path.join(ROOT, entry["objectKey"]), "rb").read()
    data = decrypt(blob, content_key)
    dest = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest, "wb").write(data)
    print("restored", path)

print("done ->", OUT)  # ASCII on purpose: Windows consoles with legacy code pages
```

> Verified against real Syncrypt output (M2): both scripts restore a vault
> byte-identically, including non-ASCII paths and superseded generations.

## Why this matters

If Syncrypt is ever unavailable, abandoned, or you simply distrust it, your data
is still fully recoverable with ~30 lines of standard code and your passphrase.
No lock-in, no proprietary format, no hidden database — as promised in
[RFC-0001](../rfc/RFC-0001-Vision.md).

> This is a sensitive operation: keep your passphrase out of shell history (use an
> environment variable as shown), and run recovery on a trusted machine.
