// Deterministic in-memory ports for engine tests (RFC-0004 §Determinism).

import { SyncError } from "../errors.js";
import type {
  ClockPort,
  LogPort,
  ObjectStat,
  ProviderCapabilities,
  PutOptions,
  PutResult,
  StateStorePort,
  StoragePort,
  VaultPort,
} from "../ports.js";
import type { ObjectKey, VaultPath } from "../types.js";
import type { SyncReportEntry } from "../report.js";

// ---------------------------------------------------------------------------
// MemoryStorage
// ---------------------------------------------------------------------------

interface StoredObject {
  data: Uint8Array;
  etag: string;
  lastModified: number;
}

export interface MemoryStorageOptions {
  /** Advertise + honor conditional writes (default true). When false, put()
   *  ignores ifMatch/ifNoneMatch — exactly like a legacy S3 vendor. */
  conditionalWrites?: boolean;
}

export class MemoryStorage implements StoragePort {
  private readonly objects = new Map<ObjectKey, StoredObject>();
  private readonly conditional: boolean;
  private etagCounter = 0;
  /** Epoch seconds used for lastModified; tests may advance it. */
  now = 1_000_000;

  constructor(opts: MemoryStorageOptions = {}) {
    this.conditional = opts.conditionalWrites ?? true;
  }

  put(key: ObjectKey, data: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    const existing = this.objects.get(key);
    if (this.conditional && opts) {
      if (opts.ifNoneMatch === "*" && existing !== undefined) {
        return Promise.reject(
          new SyncError("StoragePreconditionFailed", `object exists: ${key}`),
        );
      }
      if (opts.ifMatch !== undefined && existing?.etag !== opts.ifMatch) {
        return Promise.reject(
          new SyncError("StoragePreconditionFailed", `etag mismatch: ${key}`),
        );
      }
    }
    const etag = `"${String(++this.etagCounter)}"`;
    this.objects.set(key, {
      data: new Uint8Array(data),
      etag,
      lastModified: this.now,
    });
    return Promise.resolve({ etag });
  }

  get(key: ObjectKey): Promise<Uint8Array> {
    const obj = this.objects.get(key);
    if (obj === undefined) {
      return Promise.reject(new SyncError("StorageNotFound", `not found: ${key}`));
    }
    return Promise.resolve(new Uint8Array(obj.data));
  }

  stat(key: ObjectKey): Promise<ObjectStat> {
    const obj = this.objects.get(key);
    if (obj === undefined) {
      return Promise.reject(new SyncError("StorageNotFound", `not found: ${key}`));
    }
    return Promise.resolve({
      key,
      size: obj.data.length,
      etag: obj.etag,
      lastModified: obj.lastModified,
    });
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    for (const key of keys) {
      yield await this.stat(key);
    }
  }

  delete(key: ObjectKey): Promise<void> {
    this.objects.delete(key); // idempotent
    return Promise.resolve();
  }

  capabilities(): ProviderCapabilities {
    return {
      conditionalWrites: this.conditional,
      objectVersioning: false,
      maxSinglePutBytes: 5 * 1024 * 1024 * 1024,
    };
  }

  /** Test helper: all keys, sorted. */
  keys(): ObjectKey[] {
    return [...this.objects.keys()].sort();
  }
}

// ---------------------------------------------------------------------------
// MemoryVault
// ---------------------------------------------------------------------------

interface VaultFile {
  data: Uint8Array;
  mtime: number;
}

export class MemoryVault implements VaultPort {
  private readonly files = new Map<VaultPath, VaultFile>();
  /** Trashed versions, appended in trash order — nothing is ever lost. */
  readonly trashed: { path: VaultPath; data: Uint8Array }[] = [];
  /** Epoch seconds for mtimes; tests may advance it. */
  now = 1_000_000;

  async *list(): AsyncIterable<VaultPath> {
    for (const path of [...this.files.keys()].sort()) {
      yield await Promise.resolve(path);
    }
  }

  read(path: VaultPath): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (f === undefined) {
      return Promise.reject(new SyncError("VaultFileNotFound", `not found: ${path}`));
    }
    return Promise.resolve(new Uint8Array(f.data));
  }

  write(path: VaultPath, data: Uint8Array): Promise<void> {
    this.files.set(path, { data: new Uint8Array(data), mtime: this.now });
    return Promise.resolve();
  }

  trash(path: VaultPath): Promise<void> {
    const f = this.files.get(path);
    if (f !== undefined) {
      this.trashed.push({ path, data: f.data });
      this.files.delete(path);
    }
    return Promise.resolve();
  }

  delete(path: VaultPath): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  stat(path: VaultPath): Promise<{ size: number; mtime: number } | null> {
    const f = this.files.get(path);
    return Promise.resolve(f === undefined ? null : { size: f.data.length, mtime: f.mtime });
  }

  toNative(path: VaultPath): string {
    return path;
  }

  fromNative(native: string): VaultPath {
    return native;
  }

  /** Test helpers. */
  setFile(path: VaultPath, text: string): void {
    this.files.set(path, { data: new TextEncoder().encode(text), mtime: this.now });
  }
  getText(path: VaultPath): string | null {
    const f = this.files.get(path);
    return f === undefined ? null : new TextDecoder().decode(f.data);
  }
  paths(): VaultPath[] {
    return [...this.files.keys()].sort();
  }
}

// ---------------------------------------------------------------------------
// Clock, log, state
// ---------------------------------------------------------------------------

export class FixedClock implements ClockPort {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(seconds: number): void {
    this.current += seconds;
  }
}

export class MemoryLog implements LogPort {
  readonly entries: SyncReportEntry[] = [];
  readonly lines: string[] = [];
  entry(e: SyncReportEntry): void {
    this.entries.push(e);
    this.lines.push(`${e.path}: ${e.message}`);
  }
  info(msg: string): void {
    this.lines.push(msg);
  }
  warn(msg: string): void {
    this.lines.push(`WARN: ${msg}`);
  }
}

export class MemoryStateStore implements StateStorePort {
  private blob: Uint8Array | null = null;
  load(): Promise<Uint8Array | null> {
    return Promise.resolve(this.blob === null ? null : new Uint8Array(this.blob));
  }
  save(data: Uint8Array): Promise<void> {
    this.blob = new Uint8Array(data);
    return Promise.resolve();
  }
}
