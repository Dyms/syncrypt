// Bundle the plugin into dist/ as a loadable Obsidian plugin (CJS main.js +
// manifest.json). Obsidian provides the "obsidian" module at runtime.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
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
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  logLevel: "info",
  sourcemap: "inline",
});

await mkdir(join(root, "dist"), { recursive: true });
await copyFile(join(root, "manifest.json"), join(root, "dist/manifest.json"));
console.log("dist/ ready — copy dist/* into <vault>/.obsidian/plugins/syncrypt/");
