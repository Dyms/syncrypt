// Release packaging tests (ADR-0019): manifest validity + version sync, root
// mirrors byte-identical, the built bundle loads under a mock `obsidian`
// module, and the Node/Electron guard holds on the RELEASE bundle.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PKG = path.resolve(fileURLToPath(import.meta.url), "../..");
const REPO = path.resolve(PKG, "../..");

const read = (p: string) => readFile(p, "utf8");
const json = async (p: string) => JSON.parse(await read(p)) as Record<string, unknown>;

describe("manifest & versions (ADR-0019)", () => {
  it("manifest has the required fields and the beta identity", async () => {
    const manifest = await json(path.join(PKG, "manifest.json"));
    expect(manifest.id).toBe("syncrypt");
    expect(manifest.name).toBe("Syncrypt");
    expect(manifest.isDesktopOnly).toBe(false);
    expect(manifest.minAppVersion).toBe("1.5.0");
    expect(manifest.authorUrl).toBe("https://github.com/Dyms/syncrypt");
    for (const field of ["version", "description", "author"]) {
      expect(typeof manifest[field], field).toBe("string");
      expect((manifest[field] as string).length, field).toBeGreaterThan(0);
    }
  });

  it("version is consistent across manifest, versions.json, and the package", async () => {
    const manifest = await json(path.join(PKG, "manifest.json"));
    const versions = await json(path.join(PKG, "versions.json"));
    const pkg = await json(path.join(PKG, "package.json"));
    const version = manifest.version as string;
    expect(Object.keys(versions)).toContain(version);
    expect(versions[version]).toBe(manifest.minAppVersion);
    expect(pkg.version).toBe(version);
  });

  it("root mirrors are byte-identical to the package copies", async () => {
    for (const file of ["manifest.json", "versions.json"]) {
      const pkgCopy = await read(path.join(PKG, file));
      const rootCopy = await read(path.join(REPO, file));
      expect(rootCopy, `${file}: root mirror drifted — copy the package file to the repo root`).toBe(pkgCopy);
    }
  });
});

describe("release bundle", () => {
  let distMain = "";

  beforeAll(async () => {
    await execFileAsync(process.execPath, [path.join(PKG, "esbuild.config.mjs")], {
      cwd: REPO,
    });
    distMain = await read(path.join(PKG, "dist", "main.js"));
  }, 120_000);

  it("keeps the Node/Electron guard on the release bundle", () => {
    const banned = [
      /require\(["']node:[^"']*["']\)/,
      /require\(["'](?:fs|path|os|child_process|crypto|net|http|https)["']\)/,
      /require\(["']electron["']\)/,
      /process\.binding/,
    ];
    for (const re of banned) {
      expect(re.exec(distMain), String(re)).toBeNull();
    }
  });

  it("loads under a mock obsidian module; default export extends Plugin; onload/onunload run", async () => {
    const stage = await mkdtemp(path.join(tmpdir(), "syncrypt-pkg-"));
    await mkdir(path.join(stage, "node_modules", "obsidian"), { recursive: true });
    await cp(path.join(PKG, "dist", "main.js"), path.join(stage, "main.js"));
    await writeFile(
      path.join(stage, "node_modules", "obsidian", "package.json"),
      JSON.stringify({ name: "obsidian", version: "0.0.0", main: "index.cjs" }),
    );
    await writeFile(path.join(stage, "node_modules", "obsidian", "index.cjs"), MOCK_OBSIDIAN);

    const require2 = createRequire(path.join(stage, "main.js"));
    const mock = require2("obsidian") as { Plugin: new (...a: unknown[]) => unknown };
    const mod = require2(path.join(stage, "main.js")) as { default: new (...a: unknown[]) => unknown };

    expect(typeof mod.default).toBe("function");
    expect(Object.prototype.isPrototypeOf.call(mock.Plugin.prototype, mod.default.prototype)).toBe(true);

    // Minimal browser-ish globals the plugin touches during onload.
    (globalThis as Record<string, unknown>).window ??= globalThis;
    (globalThis as Record<string, unknown>).document ??= { visibilityState: "visible", addEventListener: () => undefined };

    const app = {
      workspace: {
        onLayoutReady: (cb: () => void) => {
          cb(); // settings incomplete → log-info path
        },
        getLeavesOfType: () => [],
        getRightLeaf: () => null,
        revealLeaf: () => Promise.resolve(),
      },
      vault: {
        adapter: {},
        on: () => ({}),
      },
    };
    const plugin = new mod.default(app, { id: "syncrypt" }) as {
      onload(): Promise<void>;
      onunload(): void;
    };
    await plugin.onload(); // must not throw on a fresh, unconfigured install
    plugin.onunload();
  });
});

// A deliberately tiny stand-in for the obsidian API surface main.js touches
// at load time. UI interactions are covered by the behavior suites; this test
// only proves the bundle is loadable and wires up cleanly.
const MOCK_OBSIDIAN = `
class Events { on() { return {}; } }
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  async loadData() { return null; }
  async saveData(_d) {}
  addSettingTab(_t) {}
  registerView(_type, _factory) {}
  addStatusBarItem() { const el = { setText() {}, setAttr() {}, addEventListener() {} }; return el; }
  addCommand(_c) {}
  registerEvent(_e) {}
  registerDomEvent(_el, _ev, _fn) {}
  registerInterval(_id) {}
}
class Modal {
  constructor(app) { this.app = app; this.titleEl = mkEl(); this.contentEl = mkEl(); }
  open() {} close() {}
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = mkEl(); } }
class ItemView { constructor(leaf) { this.leaf = leaf; this.containerEl = mkEl(); } }
class Setting {
  constructor(_el) {}
  setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addText(cb) { cb(mkText()); return this; }
  addTextArea(cb) { cb(mkText()); return this; }
  addToggle(cb) { cb({ setValue() { return this; }, onChange() { return this; } }); return this; }
  addDropdown(cb) { const d = { addOption() { return d; }, setValue() { return d; }, onChange() { return d; } }; cb(d); return this; }
  addButton(cb) { cb({ setButtonText() { return this; }, setCta() { return this; }, onClick() { return this; } }); return this; }
}
class Notice { constructor(_msg, _t) {} }
const Platform = { isMobile: false };
function requestUrl() { return Promise.resolve({ status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0) }); }
function mkText() {
  const inputEl = { type: "", style: {}, addEventListener() {}, focus() {} };
  return { inputEl, setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } };
}
function mkEl() {
  const el = {
    style: {}, children: [],
    setText() {}, empty() {}, createEl() { const c = mkEl(); return c; },
    createSpan() { return mkEl(); }, appendChild() {}, addEventListener() {},
  };
  return el;
}
module.exports = { Plugin, Modal, PluginSettingTab, ItemView, Setting, Notice, Platform, requestUrl, Events };
`;
