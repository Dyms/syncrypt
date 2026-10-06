// A small stand-in for the `obsidian` module, so the code that imports it —
// main.ts, the settings tab, the modals — runs under vitest. The root vitest
// config aliases `obsidian` here for every test.
//
// It models what that code USES, nothing more: elements are a tree of
// FakeEl with text, listeners and a click; Setting rows record their name and
// components so a test can type into a field or press a button; Modal and
// Notice record what was opened and shown. Real Obsidian behaviour a test
// depends on beyond this (layout, focus, real DOM events) is not here — a
// test that needs it says so.
//
// Grew out of the three stubs the audit №4 reproducers were written against.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-empty-function,
   @typescript-eslint/require-await, @typescript-eslint/consistent-type-definitions
   -- a stand-in for an untyped host API: empty hooks and `any` are its shape. */

type Listener = (ev?: unknown) => unknown;

export class FakeEl {
  children: FakeEl[] = [];
  text = "";
  style: Record<string, string> = {};
  disabled = false;
  value = "";
  type = "";
  readOnly = false;
  placeholder = "";
  hidden = false;
  cls = "";
  attrs: Record<string, string> = {};
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly tag = "div") {}
  createEl(tag: string, opts: { text?: string; cls?: string; type?: string } = {}): any {
    const el = new FakeEl(tag);
    if (opts.text !== undefined) el.text = opts.text;
    if (opts.cls !== undefined) el.cls = opts.cls;
    if (opts.type !== undefined) el.type = opts.type;
    this.children.push(el);
    return el;
  }
  createDiv(opts: { text?: string; cls?: string } = {}): any {
    return this.createEl("div", opts);
  }
  createSpan(opts: { text?: string; cls?: string } = {}): any {
    return this.createEl("span", opts);
  }
  setText(t: string): void {
    this.text = t;
  }
  setAttr(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addClass(c: string): void {
    this.cls = `${this.cls} ${c}`.trim();
  }
  empty(): void {
    this.children = [];
    this.text = "";
  }
  hide(): void {
    this.hidden = true;
  }
  show(): void {
    this.hidden = false;
  }
  focus(): void {}
  addEventListener(ev: string, fn: Listener): void {
    const l = this.listeners.get(ev) ?? [];
    l.push(fn);
    this.listeners.set(ev, l);
  }
  dispatch(ev: string, arg?: unknown): void {
    for (const fn of this.listeners.get(ev) ?? []) void fn(arg);
  }
  click(): void {
    if (!this.disabled) this.dispatch("click");
  }
  /** Every descendant, depth first. */
  all(): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) out.push(c, ...c.all());
    return out;
  }
  textDeep(): string {
    return [this.text, ...this.all().filter((e) => !e.hidden).map((e) => e.text)].join("\n");
  }
  buttons(): FakeEl[] {
    return this.all().filter((e) => e.tag === "button");
  }
  button(label: string): FakeEl {
    const b = this.buttons().find((e) => e.text === label);
    if (b === undefined) {
      throw new Error(`no button "${label}" in [${this.buttons().map((x) => x.text).join(", ")}]`);
    }
    return b;
  }
}

export type App = any;
export type EventRef = { id: number };
export type WorkspaceLeaf = any;

export class Modal {
  static opened: Modal[] = [];
  titleEl = new FakeEl("h1");
  contentEl = new FakeEl("div");
  isOpen = false;
  constructor(readonly app: App) {}
  open(): void {
    this.isOpen = true;
    Modal.opened.push(this);
    this.onOpen();
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class Notice {
  static shown: string[] = [];
  constructor(readonly message: string, _timeout?: number) {
    Notice.shown.push(message);
  }
}

type Handler<T> = (v: T) => unknown;

export class TextComponent {
  inputEl: FakeEl;
  private handler: Handler<string> | null = null;
  constructor(parent: FakeEl) {
    this.inputEl = parent.createEl("input");
  }
  setValue(v: string): this {
    this.inputEl.value = v;
    return this;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  onChange(fn: Handler<string>): this {
    this.handler = fn;
    return this;
  }
  /** The user types `v` into the field. */
  async type(v: string): Promise<void> {
    this.inputEl.value = v;
    await this.handler?.(v);
  }
}
export class ToggleComponent {
  value = false;
  private handler: Handler<boolean> | null = null;
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  onChange(fn: Handler<boolean>): this {
    this.handler = fn;
    return this;
  }
  async set(v: boolean): Promise<void> {
    this.value = v;
    await this.handler?.(v);
  }
}
export class DropdownComponent {
  value = "";
  options: string[] = [];
  private handler: Handler<string> | null = null;
  addOption(v: string, _label: string): this {
    this.options.push(v);
    return this;
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  onChange(fn: Handler<string>): this {
    this.handler = fn;
    return this;
  }
  async pick(v: string): Promise<void> {
    this.value = v;
    await this.handler?.(v);
  }
}
export class ButtonComponent {
  buttonEl: FakeEl;
  constructor(parent: FakeEl) {
    this.buttonEl = parent.createEl("button");
  }
  setButtonText(t: string): this {
    this.buttonEl.text = t;
    return this;
  }
  setCta(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  setDisabled(d: boolean): this {
    this.buttonEl.disabled = d;
    return this;
  }
  onClick(fn: () => unknown): this {
    this.buttonEl.addEventListener("click", fn);
    return this;
  }
}

export class Setting {
  /** Every row created, in order — a test finds a field by its name. */
  static rows: Setting[] = [];
  el: FakeEl;
  name = "";
  desc = "";
  texts: TextComponent[] = [];
  toggles: ToggleComponent[] = [];
  dropdowns: DropdownComponent[] = [];
  buttons: ButtonComponent[] = [];
  constructor(parent: FakeEl) {
    this.el = parent.createEl("div");
    Setting.rows.push(this);
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.desc = d;
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(cb: (t: TextComponent) => unknown): this {
    const t = new TextComponent(this.el);
    this.texts.push(t);
    cb(t);
    return this;
  }
  addTextArea(cb: (t: TextComponent) => unknown): this {
    return this.addText(cb);
  }
  addToggle(cb: (t: ToggleComponent) => unknown): this {
    const t = new ToggleComponent();
    this.toggles.push(t);
    cb(t);
    return this;
  }
  addDropdown(cb: (d: DropdownComponent) => unknown): this {
    const d = new DropdownComponent();
    this.dropdowns.push(d);
    cb(d);
    return this;
  }
  addButton(cb: (b: ButtonComponent) => unknown): this {
    const b = new ButtonComponent(this.el);
    this.buttons.push(b);
    cb(b);
    return this;
  }
}

export class PluginSettingTab {
  containerEl = new FakeEl();
  constructor(
    readonly app: App,
    readonly plugin: unknown,
  ) {}
  hide(): void {}
}

export class ItemView {
  containerEl = new FakeEl();
  constructor(readonly leaf: unknown) {}
}

export class Plugin {
  /** What `saveData` last wrote; `loadData` returns a copy of it. */
  data: unknown = null;
  constructor(
    readonly app: App,
    readonly manifest: any,
  ) {}
  async loadData(): Promise<unknown> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
  }
  async saveData(d: unknown): Promise<void> {
    this.data = JSON.parse(JSON.stringify(d));
  }
  addCommand(_c: unknown): void {}
  addSettingTab(_t: unknown): void {}
  registerView(): void {}
  addStatusBarItem(): FakeEl {
    return new FakeEl();
  }
  registerDomEvent(): void {}
  registerEvent(): void {}
}

export const Platform = { isMobile: false };
export const moment = { locale: (): string => "en" };
export async function requestUrl(): Promise<never> {
  throw new Error("obsidian stub: no network");
}

/** Forget what earlier tests opened, showed and rendered. */
export function resetStub(): void {
  Modal.opened = [];
  Notice.shown = [];
  Setting.rows = [];
}

const g = globalThis as any;
g.window ??= globalThis;
g.window.setTimeout ??= setTimeout;
