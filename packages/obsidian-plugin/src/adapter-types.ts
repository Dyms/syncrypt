// The narrow slice of Obsidian's DataAdapter the plugin depends on — kept as
// an interface so the vault adapter is unit-testable against a mock and the
// Obsidian API stays behind one seam (RFC-0003 layering).

export interface AdapterStat {
  type: "file" | "folder";
  size: number;
  /** Milliseconds since epoch (Obsidian convention). */
  mtime: number;
}

export interface DataAdapterLike {
  /** Direct children of a folder; entries are vault-root-relative paths. */
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  stat(path: string): Promise<AdapterStat | null>;
  remove(path: string): Promise<void>;
  /** Fails if the destination exists (Obsidian semantics). */
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Creates ONE folder level (Obsidian semantics). */
  mkdir(path: string): Promise<void>;
}
