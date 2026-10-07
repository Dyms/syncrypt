# Ручное восстановление (расшифровка без Syncrypt)

> Перевод. Источник истины — [English](../../user-guide/manual-recovery.md). При расхождении верна английская версия.

Это конкретное доказательство принципа **«данные принадлежат пользователю»**: имея
парольную фразу и документированный формат хранения, ты можешь расшифровать манифест
и каждый файл коротким скриптом — без установки Syncrypt.

> Статус: **выпущено.** Формат шифрования версионируется; скрипты ниже рассчитаны
> на формат **версии 1**. Скрипт на Node ([`recover.mjs`](../../user-guide/recover.mjs))
> в CI на каждом прогоне тестов восстанавливает настоящее зашифрованное хранилище.
> Скрипт на Python набор тестов запускает прямо из этого документа, если
> установлены `python3`, `argon2-cffi` и `cryptography` (иначе тест пропускается);
> в любом случае проверь его на копии хранилища заранее.

## Что нужно

- Твоя **парольная фраза**.
- Копия префикса хранилища:
  - `meta/keyfile-params.json` — несекретные соль и параметры Argon2id,
  - `manifests/` — зашифрованные манифесты поколений,
  - `objects/` — зашифрованные блобы файлов.

Скачать можно любым S3-клиентом (`aws s3 sync`, `rclone`, веб-интерфейс провайдера).

## Формат блоба (v1)

Каждый зашифрованный блоб (манифест или файл):

```
смещение  байт  поле
0         4     magic   = "SYNC"
4         1     version = 1
5         1     alg     = 1 (AES-256-GCM)
6         12    nonce   (случайный на каждое шифрование)
18        N     шифртекст
18+N      16    тег GCM
```

18-байтовый заголовок `magic|version|alg|nonce` — это **AAD** для GCM.

## Получение ключей (v1)

```
MasterKey   = Argon2id(парольная_фраза, соль, memoryKiB, iterations, parallelism)  → 32 байта
ContentKey  = HKDF-SHA256(MasterKey, salt=∅, info="syncrypt/content",  len=32)
ManifestKey = HKDF-SHA256(MasterKey, salt=∅, info="syncrypt/manifest", len=32)
```

Парольная фраза подаётся как **UTF-8 в нормализации Unicode NFC**. Это важно для
всего, что не ASCII, и для русской фразы в первую очередь: «й» можно ввести как
один символ или как два (и + диакритика), и Argon2id увидит разные байты.
Сначала нормализуй в NFC (`str.normalize("NFC")` в JavaScript,
`unicodedata.normalize("NFC", s)` в Python). Хранилище, созданное до того, как
Syncrypt это зафиксировал, может иметь ключ из другой формы: если NFC не
расшифровывает манифест, попробуй фразу ровно как набрана, затем в NFD.
`recover.mjs` перебирает все три сам.

Соль Argon2id в `keyfile-params.json` — **стандартный base64** (с padding). HKDF
использует пустую соль (по умолчанию в RFC 5869). Ключ имён для восстановления не
нужен: расшифрованный манифест уже перечисляет `objectKey` каждого файла.

## Выбор самого свежего манифеста

Манифесты называются `manifests/<номер поколения с нулями>-<deviceId>.json`. Бери
наибольшее поколение; если оно у двух устройств (форк) — бери **наименьший
deviceId**, он и есть победитель.

## Вариант A — скрипт на Node.js (проверяется в CI)

[`recover.mjs`](../../user-guide/recover.mjs) требует Node ≥ 20 и один пакет:

```bash
npm install hash-wasm
SYNCRYPT_PASSPHRASE='твоя фраза' node recover.mjs ./downloaded-prefix ./restored
```

## Вариант B — скрипт на Python 3

```python
#!/usr/bin/env python3
# Dependencies: pip install argon2-cffi cryptography
import base64, json, os, re, sys, unicodedata
from argon2.low_level import hash_secret_raw, Type
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."      # folder with meta/, manifests/, objects/
OUT  = sys.argv[2] if len(sys.argv) > 2 else "restored"
passphrase = unicodedata.normalize("NFC", os.environ["SYNCRYPT_PASSPHRASE"]).encode()

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
    dest = os.path.abspath(os.path.join(OUT, path))
    if not dest.startswith(os.path.abspath(OUT) + os.sep):
        raise SystemExit("refusing path outside the output folder: " + path)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest, "wb").write(data)
    print("restored", path)

print("done ->", OUT)  # ASCII on purpose: Windows consoles with legacy code pages
```

> `recover.mjs` проверен на настоящем выводе Syncrypt: он восстанавливает
> хранилище побайтово, включая пути не из ASCII и вытесненные поколения.

Оба скрипта восстанавливают **актуальные файлы самого свежего манифеста**. Прежние
версии файла автоматически не восстанавливаются: расшифрованный манифест
перечисляет их в `history[<путь>]`, у каждой свой `objectKey` — расшифруй этот
объект ключом содержимого точно так же.

## Зачем это важно

Если Syncrypt когда-нибудь станет недоступен, заброшен или ты просто ему не доверяешь
— твои данные всё равно полностью восстановимы примерно пятьюдесятью строками
стандартного кода и парольной фразой. Никакого lock-in, проприетарного формата и
скрытой базы — как обещано.

> Это чувствительная операция: не оставляй парольную фразу в истории оболочки
> (используй переменную окружения, как показано) и запускай восстановление на
> доверенной машине.
