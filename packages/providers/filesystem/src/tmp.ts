// The marker that makes a half-written file recognizable as one.
//
// Both adapters in this package write through a temp file and rename (the only
// way to get an atomic replace on a filesystem), and both therefore have to
// recognize the leftovers of a write that was interrupted — a crash, a pulled
// cable, a killed process. The storage adapter did; the vault adapter wrote
// the same kind of name and then listed it as an ordinary note, so a fragment
// of an interrupted download was published to every device and stayed for ever
// (ADR-0060).
//
// One definition, used by whoever writes a temp name and by whoever walks a
// directory, for the same reason `isUsableObjectKey` is one definition
// (ADR-0058): the two halves cannot be allowed to disagree.

export const TMP_MARKER = ".syncrypt-tmp-";

/**
 * A temp name for `target` that no concurrent writer can collide with.
 *
 * The pid matters: two processes writing the same path in the same
 * millisecond — a CLI run while the plugin syncs — would otherwise pick the
 * same temp name, and one would rename the other's half-written file into
 * place.
 */
export function tmpPathFor(target: string): string {
  const unique = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 0x1000000,
  ).toString(36)}`;
  return `${target}${TMP_MARKER}${unique}`;
}

/** True for a name this package's own interrupted write left behind. */
export function isTmpName(name: string): boolean {
  return name.includes(TMP_MARKER);
}
