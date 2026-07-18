// Bundle the plugin into dist/ as a loadable Obsidian plugin (CJS main.js +
// manifest.json). Obsidian provides the "obsidian" module at runtime.
import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(root, "dist/main.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian", "@codemirror/*", "@lezer/*"],
  logLevel: "info",
  sourcemap: "inline",
});

// MOBILE GUARD (M5, compatibility matrix): the bundle must not smuggle in any
// Node/Electron API — it runs in the Obsidian mobile webview.
const bundle = await readFile(join(root, "dist/main.js"), "utf8");
const banned = [
  /require\(["']node:[^"']*["']\)/,
  /require\(["'](?:fs|path|os|child_process|crypto|net|http|https)["']\)/,
  /require\(["']electron["']\)/,
  /process\.binding/,
];
for (const re of banned) {
  const match = re.exec(bundle);
  if (match !== null) {
    throw new Error(`Node/Electron API leaked into the mobile bundle: ${match[0]}`);
  }
}

await mkdir(join(root, "dist"), { recursive: true });
await copyFile(join(root, "manifest.json"), join(root, "dist/manifest.json"));
await copyFile(join(root, "versions.json"), join(root, "dist/versions.json"));
// styles.css does not exist today; copy it here if the plugin ever ships one.
console.log("dist/ ready (mobile-safe) — copy dist/* into <vault>/.obsidian/plugins/syncrypt/");
