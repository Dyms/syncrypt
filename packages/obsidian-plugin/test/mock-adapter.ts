// In-memory DataAdapterLike with Obsidian semantics (rename refuses existing
// targets, mkdir creates one level, list returns direct children).

import type { AdapterStat, DataAdapterLike } from "../src/adapter-types.js";

export class MockDataAdapter implements DataAdapterLike {
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  readonly folders = new Set<string>([""]);
  now = 1_000_000_000; // ms

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path === "" ? "" : `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) files.push(key);
    }
    for (const folder of this.folders) {
      if (folder === "" || !folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1 && rest !== "") folders.add(folder);
    }
    return Promise.resolve({ files: files.sort(), folders: [...folders].sort() });
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`ENOENT: ${path}`);
    const buffer = new ArrayBuffer(f.data.byteLength);
    new Uint8Array(buffer).set(f.data);
    return Promise.resolve(buffer);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, { data: new Uint8Array(data.slice(0)), mtime: this.now });
    return Promise.resolve();
  }

  async stat(path: string): Promise<AdapterStat | null> {
    const f = this.files.get(path);
    if (f !== undefined) return { type: "file", size: f.data.length, mtime: f.mtime };
    if (this.folders.has(path)) return { type: "folder", size: 0, mtime: this.now };
    return Promise.resolve(null);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (f === undefined) throw new Error(`ENOENT: ${from}`);
    if (this.files.has(to)) throw new Error(`EEXIST: ${to}`); // Obsidian semantics
    this.files.set(to, f);
    this.files.delete(from);
    return Promise.resolve();
  }

  async exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.folders.has(path));
  }

  async mkdir(path: string): Promise<void> {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!this.folders.has(parent)) throw new Error(`ENOENT parent: ${path}`);
    this.folders.add(path);
    return Promise.resolve();
  }

  // test helpers
  setFile(path: string, text: string): void {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const s of segments) {
      current = current === "" ? s : `${current}/${s}`;
      this.folders.add(current);
    }
    this.files.set(path, { data: new TextEncoder().encode(text), mtime: this.now });
  }
  getText(path: string): string | null {
    const f = this.files.get(path);
    return f === undefined ? null : new TextDecoder().decode(f.data);
  }
}
