// Corral Board: your tasks in your columns, each holding the agents you started for it.
// See RECIPE.md. Props: none → the board; { role: "pill" } → the corral layout's toggle.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, terminals, spaces, panes, machines, theme, run, exec, hc, props, layout, closeOverlay, nextCommand, knownAgents, watchFolder, focused, shared, setShared, readTextFile } from "herdr";
import { Store, newId, DIR } from "./store.js";
import { Cache, warmth, warmthColor, prLinks, prLabel, linkGroup, repoOf } from "./cache.js";
import { Codex } from "./codex.js";

const ICONS = "mods/workspace-chrome";
const COL_W = 280;
const INBOX = "inbox";
const CUSTOM = "__custom";
// In notes and the first message, Enter saves / launches and Shift+Enter is a new line, as in Claude Code.
// Bump on every change: shown in the header and the ? bar, to see which build is running.
const BUILD = "0.1.10";

// Demo mode, for screenshots: with corral/demo.json present the board shows that file's board, spaces and
// agents instead of the real ones, and saves, labels and polls nothing. See RECIPE "Demo mode".
let DEMO = null;
const src = {
  agents: () => (DEMO ? DEMO.agents : agents()),
  terminals: () => (DEMO ? DEMO.terms : terminals()),
  spaces: () => (DEMO ? DEMO.spaces : spaces()),
};

// demo.json: { board, spaces: [{ id, name, color }], agents: [{ address, task?, title, app, space, status,
// cache?: { min, ttl } }] }. Program icons are borrowed from a real agent of the same app, when one runs.
function loadDemo(d) {
  const real = agents();
  const now = Date.now();
  const space = (id) => d.spaces.find((x) => x.id === id);
  DEMO = {
    spaces: d.spaces,
    agents: d.agents.map((a) => ({ address: a.address, title: a.title, status: a.status, app: a.app, space: a.space, space_name: space(a.space)?.name ?? "",
      program: real.find((x) => x.app === a.app && x.program)?.program ?? { name: a.app } })),
    terms: d.agents.map((a) => ({ address: a.address, state: "live", report: { app: a.app }, labels: a.task ? { "corral.task": a.task } : {}, foreground: { pid: 1 },
      status_ms: now - (a.waited ?? 3) * 60000,
      demo: a.cache ? { expires: now + a.cache.min * 60000, ttl: a.cache.ttl ?? "1h", waitingFor: null } : null })),
  };
  return d.board;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

// Asks the board for the keyboard again once the flip has applied: the first ask (in flip) re-renders
// the board while the stack still shows the terminals, and a hidden board ignores it.
function askFocusSoon(cx) {
  cx.spawn(async (cx) => {
    await cx.sleep(120);
    if (find(layout(), "corral-view")?.active === "board") setShared("corral.focusAt", Date.now());
  });
}

// Flips the corral layout's work area between the terminals and the board.
function flip(to, refocus = true) {
  const stack = find(layout(), "corral-view");
  if (!stack) return false;
  const child = to ?? (stack.active === "board" ? "main" : "board");
  run("layout.select", { stack: "corral-view", child });
  // The keyboard follows: the board takes it when it renders next; the terminals get their focused pane back.
  if (child === "board") setShared("corral.focusAt", Date.now());
  // A plain switch back gives the keyboard to the focused pane; callers that just focused an agent pass
  // refocus = false, or this would focus the previous pane again (focused() hasn't caught up yet).
  else if (refocus) { const f = focused(); if (f?.pane) run("pane.focus", { pane: f.pane }); }
  return true;
}

// A theme color with this alpha (two hex digits). Theme colors may already carry one (#rrggbbaa).
const alpha = (c, a) => (c ?? "#000000").slice(0, 7) + a;

// A space's tile, as Herdr's spaces sidebar draws it: its first letter on its color. The spaces mod assigns
// the colors (shared "space.colors": space id → ansiN); MARK is that mod's own table of them. Without the
// spaces mod no color is assigned and every tile shows its default.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function spaceTile(t, space, size = 14) {
  if (!space) return div();
  const color = space.color ?? shared("space.colors")?.[space.id] ?? "ansi6";
  const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  return h_flex().size(size).flex_none().rounded(size * 0.28).bg(fill).items_center().justify_center()
    .text_size(size * 0.6).font_bold().text_color("#ffffff").child([...space.name][0]?.toUpperCase() ?? "?");
}

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);

// Opens a link in the browser on this computer.
function openUrl(url) {
  exec("open", [url]).catch(() => exec("xdg-open", [url]).catch(() => {}));
}

// Where a space is now: its first terminal's live folder, else where it was made (as the worktree mod reads it).
function placeOf(s) {
  const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder || null;
}
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
// How long ago, short: "<1m", "6m", "2h", "3d".
function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

// Since when an agent has been waiting on you, as plain words (never a pill, so it can't be read as the
// cache badge): "waiting 6m", for needs you or done and not looked at. Null otherwise: Herdr's status_ms is
// when the agent's own status last changed, and looking at a done agent (done → idle) doesn't move it, so
// an idle agent's time would be when it finished, not how long it has sat seen.
function waited(status, term, now) {
  const at = term?.status_ms;
  if (!at || (status !== "blocked" && status !== "done")) return null;
  return `waiting ${ago(at, now)}`;
}

// A row's links, oldest mention first: { u, at } (at: first seen, ms). Older boards stored bare URLs.
const linksOf = (r) => (r.links ?? []).map((l) => (typeof l === "string" ? { u: l, at: null } : l));

// The links shown on a row that isn't picked: the newest of each repository (or Jira project), newest
// first, at most three. Picked: all of them, newest first, each numbered.
function rowLinks(r, all) {
  const list = linksOf(r).reverse();
  if (all) return linkGroups(r).flatMap((g) => g.links).slice(0, 9);
  const seen = new Set();
  return list.filter((l) => { const g = linkGroup(l.u); if (seen.has(g)) return false; seen.add(g); return true; }).slice(0, 3);
}

// A row's links by repository (or Jira project), the group with the newest link first, newest first within.
function linkGroups(r) {
  const groups = [];
  for (const l of linksOf(r).reverse()) {
    const g = linkGroup(l.u);
    let x = groups.find((y) => y.g === g);
    if (!x) groups.push((x = { g, name: repoOf(l.u) ?? `${g} (Jira)`, links: [] }));
    x.links.push(l);
  }
  return groups;
}

// A link's short name inside its group: "#412", "!7", or the Jira key.
const shortLabel = (u) => (repoOf(u) ? prLabel(u).slice(repoOf(u).length + 1) : prLabel(u));

const NAV = ["h", "l", "j", "k", "g", "G", "shift-g", "left", "right", "up", "down"];

// What a person calls an agent: its own title, unless that only names the program.
function agentName(a) {
  if (a.title && a.title !== a.program?.name) return a.title;
  if (a.tab_name && !/^\d+$/.test(a.tab_name)) return a.tab_name;
  return a.space_name || a.program?.name || a.address;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The column menu (⋯, or c): action, label, its key while the menu is open.
const COL_MENU = [["rename", "Rename", "r"], ["left", "Move left", "h"], ["right", "Move right", "l"], ["before", "Add column before", "b"], ["add", "Add column after", "a"], ["delete", "Delete column", "d"]];

export default class Board extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "board";
    if (this.role === "pill") {
      cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "toggle") { flip(); askFocusSoon(cx); } cx.notify(); } });
      return;
    }
    this.store = new Store();
    this.cache = new Cache();
    this.codex = new Codex();
    this.focus = cx.focus_handle();
    this.sel = { c: 1, i: 0 };
    this.open = null;      // the opened task's id
    this.inputs = new Set(); // text boxes holding the keyboard (board keys stay off): see typing
    this.press = null;     // a press that may become a drag
    this.drag = null;
    this.over = null;      // where a drag would land: { col, index } or { task }
    this.bar = null;       // the bottom prompt: confirm, move picker or help
    this.known = {};       // knownAgents per machine
    this.launch = null;    // the open card's launch form
    this.colMenu = null;
    this.rename = null;    // { kind: "task" | "column" | "inbox", id, state }
    this.archiveView = null; // { i }: the Archive view, its selected row
    this.attach = null;    // { address, name }: an Inbox agent being added to a task by key (t)
    this.screenLinks = new Map(); // address → PR links seen on a (non-Claude) agent's screen
    // No cx.bind_keys: its bindings are app-wide and outlive a reload (a removed one fails as an unknown
    // command until Herdr restarts). Enter variants arrive as the textarea's "submit" event instead.
    this.filterState = this.input("Filter tasks  ( / )", "", (s) => { this.filter = s.value().toLowerCase(); });
    this.filter = "";
    // The 30s tick waits for this: in demo mode it must never touch the real board.
    this.ready = new Promise((resolve) => { this.isReady = resolve; });
    cx.spawn(async (cx) => {
      const demo = await readTextFile(`${DIR()}/demo.json`).catch(() => null);
      if (demo) {
        this.store.board = loadDemo(JSON.parse(demo));
        this.store.demo = true;
        this.cache.info = (term) => term?.demo ?? null;
        this.isReady();
        cx.notify();
        return;
      }
      await this.store.load();
      this.isReady();
      await this.adopt();
      cx.notify();
      for (;;) {
        try { await watchFolder(DIR()); } catch (_e) { await cx.sleep(5000); }
        if (await this.store.load()) cx.notify();
      }
    });
    // Focus can only move from a task, and tasks spawned during render don't run: render wakes this one.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((resolve) => { this.wakeFocus = resolve; });
        this.wakeFocus = null;
        // Never out of a text box that has (or was just given) the keyboard.
        for (const ms of [0, 60, 200]) {
          if (ms) await cx.sleep(ms);
          if (this.inputs.size || this.rename || this.notesEdit || this.boxJustFocused()) break;
          this.focus.focus();
        }
        cx.notify();
      }
    });
    const tick = (cx) => cx.spawn(async (cx) => {
      await this.ready;
      if (DEMO) return;
      await this.cache.refresh(src.terminals(), cx, () => {});
      await this.codex.refresh(src.terminals(), new Set(machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name)));
      // With several copies open (a popup over the layout's board, boards in two windows), one keeps the
      // board's records: two writing them at once would each wipe the other's undo history. A copy takes over
      // once the keeper has been quiet for two ticks (closed).
      this.copyId ??= newId("v");
      const keeper = shared("corral.keeper");
      if (keeper && keeper.id !== this.copyId && Date.now() - keeper.at < 75000) { cx.notify(); return; }
      setShared("corral.keeper", { id: this.copyId, at: Date.now() });
      await this.adopt();
      await this.recordSessions();
      await this.scanScreens();
      await this.recordLinks();
      cx.notify();
    });
    tick(cx);
    cx.timer.every(30000, tick);
  }

  // An InputState that keeps board keys off while it has the keyboard.
  input(placeholder, value, onChange, multi = false) {
    const s = multi ? TextareaState.new({ placeholder, value }) : InputState.new({ placeholder, value });
    s.on("focus", (_e, cx) => { this.inputs.add(s); cx.notify(); });
    s.on("blur", (_e, cx) => { this.inputs.delete(s); cx.notify(); });
    if (onChange) s.on("change", (_e, cx) => { onChange(s); cx.notify(); });
    return s;
  }

  // Whether a text box has the keyboard. A box that disappears while focused (its card closed, the branch
  // field hidden, an undo) sends no blur, so the board holding the keyboard itself overrules the set.
  get typing() {
    if (this.inputs.size && this.focus.is_focused()) this.inputs.clear();
    return this.inputs.size > 0;
  }

  // The text boxes on screen now; one that holds the keyboard but isn't among them hands it back to the board.
  liveInputs() {
    const L = this.open && this.launch;
    return new Set([this.filterState, this.open && this.openMode === "info" && this.notes, this.notesEdit && this.task(this.notesEdit.id) && this.notesEdit.state, this.rename?.state,
      L && L.msg, L && L.agent === CUSTOM && L.custom, L && L.worktree && L.branch].filter(Boolean));
  }

  get board() { return this.store.board; }
  // Gives a text box the keyboard. For a moment after, the board doesn't take it back: the box that just
  // lost it saves and would refocus the board, and so would the focus retries after a flip.
  focusBox(s) { this.boxAt = Date.now(); this.lastBox = s; s.focus(); }
  boxJustFocused() { return Date.now() - (this.boxAt ?? 0) < 400; }
  // The board takes the keyboard back from a box that closed, unless another box was just given it.
  refocus(closing) {
    const shown = !!props()?.overlay || find(layout(), "corral-view")?.active === "board";
    if (shown && (!this.boxJustFocused() || this.lastBox === closing)) this.focus.focus();
  }
  task(id) { return this.board.tasks.find((t) => t.id === id); }
  change(fn, cx) { cx.spawn(async (cx) => { await this.store.change(fn); cx.notify(); }); }

  // Live terminals labelled for a task rejoin it, even if the file lost them.
  async adopt() {
    const missing = [];
    for (const t of src.terminals()) {
      const id = t.labels?.["corral.task"];
      const task = id && this.task(id);
      // Only terminals running an agent rejoin: a shell left after its agent exited is not one.
      if (task && t.state === "live" && t.report?.app && !task.agents.some((a) => a.address === t.address)) missing.push([id, t]);
    }
    if (!missing.length) return;
    await this.store.change((b) => {
      for (const [id, t] of missing) {
        const task = b.tasks.find((x) => x.id === id);
        // A terminal can have no title yet (just started): fall back to its program, then the task.
        if (task && !task.agents.some((a) => a.address === t.address)) task.agents.push({ address: t.address, app: t.report?.app ?? null, name: t.title || t.program?.name || task.title, space: t.labels?.["herdr.space"] ?? null, started: t.created_ms ?? Date.now() });
      }
    }, { auto: true });
  }

  // Remembers each live Claude or Codex agent's session and folder on its row: what resuming needs later.
  async recordSessions() {
    const terms = new Map(src.terminals().map((x) => [x.address, x]));
    const ups = [];
    for (const t of this.board.tasks) for (const r of t.agents) {
      const term = terms.get(r.address);
      if (term?.labels?.["corral.task"] !== t.id) continue;
      const app = term.report?.app;
      // Claude: resumable only once the conversation is on disk (written with the first message;
      // `claude --resume` refuses a session that has none). Codex writes its session file at start.
      const c = app === "claude-code" ? this.cache.info(term) : app === "codex" ? this.codex.info(term) : null;
      const info = c?.sid && (app !== "claude-code" || c.path) ? c : null;
      if (info && (r.session !== info.sid || r.cwd !== info.cwd || r.app !== app)) ups.push([t.id, r.address, info.sid, info.cwd, app]);
    }
    if (!ups.length) return;
    await this.store.change((b) => {
      for (const [tid, addr, sid, cwd, app] of ups) {
        const r = b.tasks.find((x) => x.id === tid)?.agents.find((x) => x.address === addr);
        if (r) { r.session = sid; r.cwd = cwd; r.app = app; }
      }
    }, { auto: true });
  }

  // PR links an agent printed: Claude's come from its transcript (cache.js), other agents' from their
  // screen (a link must be on screen at a 30s tick to be seen; a wrapped one may be missed).
  async scanScreens() {
    const terms = new Map(src.terminals().map((x) => [x.address, x]));
    for (const t of this.board.tasks) for (const r of t.agents) {
      const term = terms.get(r.address);
      if (term?.state !== "live" || !term.report?.app || term.report.app === "claude-code") continue;
      try {
        const x = await hc(["read", r.address, "--json"]);
        const found = prLinks(JSON.parse(x.stdout || "{}").text ?? "");
        if (found.length) this.screenLinks.set(r.address, found);
      } catch (_e) { /* gone meanwhile */ }
    }
  }

  // Keeps the last ten links of each agent on its row (in mention order, each with when it was first seen),
  // so they stay after the agent ends.
  async recordLinks() {
    const terms = new Map(src.terminals().map((x) => [x.address, x]));
    const ups = [];
    for (const t of this.board.tasks) for (const r of t.agents) {
      const term = terms.get(r.address);
      if (term?.labels?.["corral.task"] !== t.id) continue;
      const found = term.report?.app === "claude-code" ? this.cache.info(term)?.prs : this.screenLinks.get(r.address);
      if (!found?.length) continue;
      const old = linksOf(r);
      const urls = prLinks([...old.map((l) => l.u), ...found].join(" ")).slice(-10);
      if (urls.join(" ") === old.map((l) => l.u).join(" ") && !(r.links ?? []).some((l) => typeof l === "string")) continue;
      const now = Date.now();
      ups.push([t.id, r.address, urls.map((u) => ({ u, at: old.find((l) => l.u === u)?.at ?? now }))]);
    }
    if (!ups.length) return;
    await this.store.change((b) => {
      for (const [tid, addr, links] of ups) {
        const r = b.tasks.find((x) => x.id === tid)?.agents.find((x) => x.address === addr);
        if (r) r.links = links;
      }
    }, { auto: true });
  }

  // Archives a task, or deletes it: both go to the archive (the Archive view restores them); deleted ones
  // are marked and dropped after 30 days.
  shelve(task, cx, deleted = false) {
    const now = Date.now();
    this.change((b) => {
      const tk = b.tasks.find((x) => x.id === task.id);
      if (!tk) return;
      b.tasks = b.tasks.filter((x) => x.id !== task.id);
      b.archive.push({ ...tk, archived: now, ...(deleted ? { deleted: now } : {}) });
      b.archive = b.archive.filter((x) => !x.deleted || now - x.deleted < 30 * 86400000);
    }, cx);
  }

  restore(id, cx) {
    this.change((b) => {
      let i = b.archive.length - 1;
      while (i >= 0 && b.archive[i].id !== id) i--;
      if (i < 0) return;
      const [x] = b.archive.splice(i, 1);
      delete x.archived; delete x.deleted;
      if (!b.columns.some((c) => c.id === x.column)) x.column = b.columns[0].id;
      x.updated = Date.now();
      b.tasks.push(x);
    }, cx);
  }

  // Undoes this window's last change to the board. Terminal labels follow, or the 30s rejoin would
  // put an agent back where the undo took it from.
  // The board keeps the keyboard, and a task the step moved (or brought back) is selected.
  undo(cx, redo = false) {
    cx.spawn(async (cx) => {
      const r = await (redo ? this.store.redo() : this.store.undo());
      this.focus.focus();
      const word = redo ? "redo" : "undo";
      if (!r || r === "changed") {
        this.bar = { kind: "note", text: r ? `The board changed elsewhere since, so ${word} stopped. Older versions are in corral/backups.` : redo ? "Nothing to redo." : "Nothing to undo (only this window's changes, since it opened)." };
        cx.notify(); return;
      }
      // The task the step moved: back, to another column, or within one (its "updated" changes when placed).
      const moved = r.to.tasks.find((x) => { const o = r.from.tasks.find((y) => y.id === x.id); return !o || o.column !== x.column || o.updated !== x.updated; });
      const c = moved ? r.to.columns.findIndex((col) => col.id === moved.column) + 1 : 0;
      if (c > 0) { this.follow = { id: moved.id, c }; this.sel = { c, i: Infinity }; this.pickAgent = null; }
      const owner = (b) => { const m = new Map(); for (const t of b.tasks) for (const a of t.agents) m.set(a.address, t.id); return m; };
      const was = owner(r.from);
      const now = owner(r.to);
      const live = new Set(src.terminals().map((x) => x.address));
      for (const addr of new Set([...was.keys(), ...now.keys()])) if (was.get(addr) !== now.get(addr) && live.has(addr)) this.label(addr, now.get(addr) ?? null);
      cx.notify();
    });
  }

  // The Archive view's rows: newest first, through the filter.
  archived() {
    const f = this.filter;
    return [...this.board.archive].reverse().filter((x) => !f || `${x.title}\n${x.notes ?? ""}\n${(x.agents ?? []).map((a) => a.name).join("\n")}`.toLowerCase().includes(f));
  }

  archiveKey(k, cx) {
    const list = this.archived();
    const v = this.archiveView;
    if (k === "j" || k === "down") v.i++;
    else if (k === "k" || k === "up") v.i--;
    else if (k === "g") v.i = 0;
    else if (k === "G" || k === "shift-g") v.i = list.length - 1;
    else if ((k === "r" || k === "enter") && list[v.i]) this.restore(list[v.i].id, cx);
    else if (k === "u") this.undo(cx);
    else if (k === "U" || k === "shift-u" || k === "ctrl-r") this.undo(cx, true);
    else if (k === "/") this.focusBox(this.filterState);
    else if (k === "escape" || k === "A" || k === "shift-a") this.archiveView = null;
    if (this.archiveView) v.i = Math.max(0, Math.min(list.length - 1, v.i));
    cx.notify();
  }

  // Starts an ended agent again with its conversation, in its folder: `claude --resume <session>` or
  // `codex resume <session>`.
  async revive(taskId, row, cx) {
    if (DEMO) { this.bar = { kind: "note", text: "Demo mode: nothing is started." }; cx.notify(); return; }
    // A second click while the first resume is still starting would open a second agent on the conversation.
    const key = `${taskId}|${row.session}`;
    this.reviving ??= new Set();
    if (this.reviving.has(key)) return;
    this.reviving.add(key);
    try { await this.reviveNow(taskId, row, cx); } finally { this.reviving.delete(key); }
  }

  async reviveNow(taskId, row, cx) {
    const task = this.task(taskId);
    // The conversation lives on the machine the agent ran on: resume there, never on another machine.
    const m = machineOf(row.address);
    const here = src.spaces().filter((s) => (s.machine ?? null) === m);
    const space = here.find((s) => s.id === (row.space ?? task?.space)) ?? here.find((s) => s.active) ?? here[0];
    if (!task || !row.session) return;
    if (!space) { this.bar = { kind: "note", text: `Couldn't resume: no space open on ${m ?? "this computer"}` }; cx.notify(); return; }
    try {
      const argv = row.app === "codex" ? ["codex", "resume", row.session] : ["claude", "--resume", row.session];
      const args = { space: space.id, name: row.name, argv };
      if (row.cwd) args.folder = row.cwd;
      const r = await exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]);
      const out = JSON.parse(r.stdout || "{}");
      if (r.code !== 0 || !out.terminal) throw new Error(out.error ?? (r.stderr || "no terminal"));
      await hc(["label", out.terminal, `corral.task=${taskId}`]);
      await this.store.change((b) => {
        const x = b.tasks.find((t) => t.id === taskId)?.agents.find((a) => a.address === row.address && a.session === row.session);
        if (x) { x.address = out.terminal; x.space = space.id; x.started = Date.now(); }
      });
      this.press = this.drag = this.over = null;
      run("pane.focus", { terminal: out.terminal });
      if (props()?.overlay) closeOverlay(props().overlay);
      else flip("main", false);
    } catch (e) {
      this.bar = { kind: "note", text: `Couldn't resume: ${e?.message ?? e}` };
    }
    cx.notify();
  }

  // Takes an agent row off a task. The terminal's label is cleared only while it still points at this task:
  // a stale row (the agent moved on to another task since) must not pull it off that one.
  unlist(taskId, address, cx) {
    if ((this.terms?.get(address)?.labels?.["corral.task"] ?? taskId) === taskId) this.label(address, null);
    this.change((b) => { const tk = b.tasks.find((x) => x.id === taskId); if (tk) tk.agents = tk.agents.filter((r) => r.address !== address); }, cx);
  }

  // One agent row's live facts: "live" with its agent, "ended", or "unknown" (its machine is away).
  rowState(task, row, terms, ags) {
    const term = terms.get(row.address);
    const m = machineOf(row.address);
    if (!term) {
      const away = m && machines().find((x) => x.name === m)?.layout !== "ready";
      return { state: away ? "unknown" : "ended" };
    }
    const lb = term.labels?.["corral.task"];
    // Live but on another task now (this row came back with an older copy of the task, say): not resumable.
    if (term.state === "live" && lb && lb !== task.id && this.task(lb)) return { state: "ended", elsewhere: true };
    if (term.state !== "live" || lb !== task.id) return { state: "ended" };
    const a = ags.get(row.address);
    return a ? { state: "live", agent: a, term } : { state: "ended" };
  }

  // The spaces a task belongs to: its own, and each of its agents' (where it runs now, else where it ran).
  spacesOf(task, ags) {
    const out = new Set(task.space ? [task.space] : []);
    for (const r of task.agents) { const s = ags.get(r.address)?.space ?? r.space; if (s) out.add(s); }
    return out;
  }

  // The space chips: each space with something on the board, in the sidebar's order, with how many tasks
  // (and Inbox agents) it has and whether an agent there waits for you. Only with two spaces or more.
  spaceChips(t) {
    const ags = this.ags;
    const count = new Map();
    const add = (id) => count.set(id, (count.get(id) ?? 0) + 1);
    for (const tk of this.board.tasks) for (const id of this.spacesOf(tk, ags)) add(id);
    for (const a of this.inboxAll ?? []) add(a.space);
    const list = src.spaces().filter((s) => count.has(s.id));
    if (list.length < 2 && !this.spaceFilter) return null;
    const waiting = new Set([...ags.values()].filter((a) => a.status === "blocked" || a.status === "done").map((a) => a.space));
    const chip = (id, label, n, sp) => {
      const on = this.spaceFilter === id;
      return h_flex().id(`sf-${id ?? "all"}`).flex_none().h(22).px(7).gap(5).items_center().rounded(6).cursor_pointer().text_size(11.5)
        .bg(on ? t.selected : alpha(t.foreground, "0a")).text_color(on ? t.foreground : t.muted).hover((el) => el.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.spaceFilter = on ? null : id; this.focus.focus(); cx.notify(); })
        .when(!!sp, (el) => el.child(spaceTile(t, sp, 12)))
        .child(label)
        .child(div().text_color(t.dim).child(String(n)))
        .when(!!id && waiting.has(id), (el) => el.child(div().size(6).rounded(3).bg(t.blocked)));
    };
    return h_flex().id("spacechips").flex_none().h(34).px(14).gap(6).items_center().border_b(1).border_color(t.border).overflow_hidden()
      .child(this.kbd(t, "s"))
      .child(chip(null, "All", this.board.tasks.length + (this.inboxAll?.length ?? 0), null))
      .children(list.map((s) => chip(s.id, s.name, count.get(s.id), s)));
  }

  // Columns as shown: Inbox first (agents in no task), then the board's, filtered.
  shown(terms, ags) {
    const claimed = new Set();
    for (const t of this.board.tasks) for (const r of t.agents) if (this.rowState(t, r, terms, ags).state !== "ended") claimed.add(r.address);
    const inbox = [...ags.values()].filter((a) => !claimed.has(a.address) && !terms.get(a.address)?.parent);
    this.inboxAll = inbox; // before any filter: the space chips count from it
    const f = this.filter;
    const sf = this.spaceFilter;
    const match = (t) => (!f || `${t.title}\n${t.notes ?? ""}\n${t.agents.map((a) => a.name).join("\n")}`.toLowerCase().includes(f))
      && (!sf || this.spacesOf(t, ags).has(sf));
    return [
      { id: INBOX, name: "Inbox", items: inbox.filter((a) => (!f || agentName(a).toLowerCase().includes(f)) && (!sf || a.space === sf)).map((a) => ({ kind: "inbox", id: a.address, agent: a })) },
      ...this.board.columns.map((c) => ({ id: c.id, name: c.name, items: this.board.tasks.filter((t) => t.column === c.id && match(t)).map((t) => ({ kind: "task", id: t.id, task: t })) })),
    ];
  }

  // ---- changes ----

  // The Done column: the board's own, else one named "Done". None: space, X and Clear aren't offered.
  doneColumn() { return this.board.columns.find((c) => c.id === "done") ?? this.board.columns.find((c) => c.name.trim().toLowerCase() === "done") ?? null; }
  askClearDone() {
    const done = this.doneColumn();
    if (!done) { this.bar = { kind: "note", text: "No Done column: name a column Done." }; return; }
    const n = this.board.tasks.filter((t) => t.column === done.id).length;
    if (n) this.ask(`Archive all ${n} task${n === 1 ? "" : "s"} in ${done.name}?`, (cx) => this.clearDone(cx));
  }

  // Puts a task in a column before the item now at `index` among that column's tasks.
  place(b, taskId, col, index) {
    const from = b.tasks.findIndex((t) => t.id === taskId);
    const [task] = b.tasks.splice(from, 1);
    task.column = col;
    task.updated = Date.now();
    const inCol = b.tasks.filter((t) => t.column === col);
    const before = inCol[index];
    if (before) b.tasks.splice(b.tasks.indexOf(before), 0, task);
    else if (inCol.length) b.tasks.splice(b.tasks.indexOf(inCol.at(-1)) + 1, 0, task);
    else b.tasks.push(task);
  }

  // K / J pressed faster than the board saves: each press acts on the order as already pressed (the last
  // move applied on top of what's shown), not on the order last saved, or it moved the wrong card.
  order(col) {
    const ids = col.items.map((x) => x.id);
    const p = this.reordering;
    if (p && p.col === col.id) { const j = ids.indexOf(p.id); if (j >= 0) { ids.splice(j, 1); ids.splice(p.i, 0, p.id); } }
    return ids;
  }

  reorder(col, id, before, after, i, cx) {
    if (!id) return;
    const n = (this.reordering?.n ?? 0) + 1;
    this.reordering = { col: col.id, id, i, n };
    cx.spawn(async (cx) => {
      await this.store.change((b) => this.placeNear(b, id, col.id, before, after));
      if (this.reordering?.n === n) this.reordering = null;
      cx.notify();
    });
  }

  // Puts a task in a column just before task `before`, or just after task `after` (the cards shown around
  // the spot, so hidden ones don't shift it), or at the column's end.
  placeNear(b, taskId, col, before, after) {
    if (before === taskId || after === taskId) return;
    const from = b.tasks.findIndex((t) => t.id === taskId);
    if (from < 0) return;
    const [task] = b.tasks.splice(from, 1);
    task.column = col;
    task.updated = Date.now();
    const at = (id) => (id ? b.tasks.findIndex((t) => t.id === id && t.column === col) : -1);
    let k = at(before);
    if (k < 0 && at(after) >= 0) k = at(after) + 1;
    if (k < 0) { const inCol = b.tasks.filter((t) => t.column === col); k = inCol.length ? b.tasks.indexOf(inCol.at(-1)) + 1 : b.tasks.length; }
    b.tasks.splice(k, 0, task);
  }

  newTask(b, col, title, agent) {
    const now = Date.now();
    const task = { id: newId("t"), title, notes: "", column: col, space: agent?.space ?? null, created: now, updated: now, agents: [] };
    if (agent) task.agents.push(this.rowFrom(agent));
    b.tasks.push(task);
    return task;
  }

  rowFrom(a) {
    return { address: a.address, app: a.app ?? null, name: agentName(a), space: a.space ?? null, started: Date.now() };
  }

  // A label value of "" removes the label.
  label(address, taskId) { if (DEMO) return; hc(["label", address, `corral.task=${taskId ?? ""}`]).catch(() => {}); }

  drop(cx) {
    const { press, over } = this;
    if (!press || !over) return;
    const colAt = (id) => (this.cols ?? []).findIndex((c) => c.id === id);
    if (press.kind === "task") {
      if (!over.col || over.col === INBOX) return;
      // Before the card shown at that spot (or after the last one shown): dropping a card further down its
      // own column, or past cards a filter hides, lands where the line was.
      const items = (this.cols ?? [])[colAt(over.col)]?.items ?? [];
      const before = items[over.index]?.id ?? null;
      const after = before ? null : items.at(-1)?.id ?? null;
      if (before !== press.id && after !== press.id) this.change((b) => this.placeNear(b, press.id, over.col, before, after), cx);
      this.follow = { id: press.id, c: colAt(over.col) };
      return;
    }
    // An agent: from the Inbox, or a row of a task (press.from).
    const a = src.agents().find((x) => x.address === press.id);
    const from = press.from ?? null;
    const unhook = (b) => { const s = from && b.tasks.find((t) => t.id === from); if (s) s.agents = s.agents.filter((r) => r.address !== press.id); };
    // A row moved from another task keeps what it knew (its session for resume, its links); an Inbox agent
    // gets a new row. Either way the task lists the agent once.
    const take = (b) => {
      const old = from && b.tasks.find((t) => t.id === from)?.agents.find((r) => r.address === press.id);
      unhook(b);
      return old ? { ...old } : this.rowFrom(a);
    };
    if (over.task) {
      if (over.task === from || !a) return;
      this.label(press.id, over.task);
      this.change((b) => {
        const row = take(b);
        const tk = b.tasks.find((t) => t.id === over.task);
        if (tk) { tk.agents = tk.agents.filter((r) => r.address !== press.id); tk.agents.push(row); }
      }, cx);
      const tk = this.task(over.task);
      if (tk) this.follow = { id: tk.id, c: colAt(tk.column) };
    } else if (over.col === INBOX) {
      if (!from) return;
      this.label(press.id, null);
      this.change(unhook, cx);
    } else if (over.col && a) {
      const id = newId("t");
      this.label(a.address, id);
      const items = (this.cols ?? [])[colAt(over.col)]?.items ?? [];
      const before = items[over.index]?.id ?? null;
      const after = before ? null : items.at(-1)?.id ?? null;
      this.change((b) => { const row = take(b); const tk = this.newTask(b, over.col, agentName(a), a); tk.id = id; tk.agents = [row]; this.placeNear(b, id, over.col, before, after); }, cx);
      this.follow = { id, c: colAt(over.col) };
    }
  }

  async doLaunch(task, cx) {
    const L = this.launch;
    if (DEMO) { L.error = "Demo mode: nothing is started."; cx.notify(); return; }
    const space = src.spaces().find((s) => s.id === L.space);
    let argv;
    if (L.agent === CUSTOM) {
      const cmd = L.custom.value().trim();
      argv = cmd.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
    } else {
      argv = (this.known[space?.machine ?? ""] ?? []).find((k) => k.key === L.agent)?.run;
    }
    if (!space || !argv?.length) { L.error = "Pick a space and an agent."; cx.notify(); return; }
    const message = L.msg.value().trim();
    // A second agent on the task gets a number, so their tabs and rows differ.
    const n = task.agents.length;
    const name = n ? `${task.title} ${n + 1}` : task.title;
    const args = { space: space.id, name, argv };
    if (message) args.task = message;
    L.busy = true; L.error = null; cx.notify();
    try {
      if (L.worktree) args.folder = await this.makeWorktree(space, L.branch.value().trim());
      const r = await exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]);
      const out = JSON.parse(r.stdout || "{}");
      if (r.code !== 0 || !out.terminal) throw new Error(out.error ?? (r.stderr || "no terminal"));
      await hc(["label", out.terminal, `corral.task=${task.id}`]);
      await this.store.change((b) => {
        const t = b.tasks.find((x) => x.id === task.id);
        if (!t) return; // archived meanwhile: the agent waits in the Inbox
        t.space = space.id;
        t.agents.push({ address: out.terminal, app: null, name, space: space.id, started: Date.now() });
        if (L.agent === CUSTOM) b.prefs = { ...b.prefs, customCommand: L.custom.value().trim() };
      });
      L.busy = false;
      this.open = null;
      this.press = this.drag = this.over = null;
      run("pane.focus", { terminal: out.terminal });
      if (props()?.overlay) closeOverlay(props().overlay);
      else flip("main", false);
    } catch (e) {
      L.busy = false;
      L.error = String(e?.message ?? e);
    }
    cx.notify();
  }

  // A git worktree to launch in, where Herdr's worktree mod keeps them (~/.herdr/worktrees/<repo>/<branch>),
  // so its open and remove find it. Made from the space's folder: an existing branch is checked out, a new
  // one starts at that folder's HEAD; a checkout already at that path is reused.
  async makeWorktree(space, branch) {
    if (!branch) throw new Error("Type a branch name for the worktree.");
    const on = space.machine ?? null;
    const git = async (cwd, args) => {
      const r = await exec("git", args, { cwd, on });
      return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
    };
    const h = await this.cache.homeOf(on);
    const base = placeOf(space) || h;
    const common = await git(base, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common.ok) throw new Error(`${base} isn't in a git repository (the space's folder).`);
    const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
    const path = `${h}/.herdr/worktrees/${main.split("/").pop()}/${slug(branch)}`;
    const list = await git(main, ["worktree", "list", "--porcelain"]);
    // Reused only when it holds this branch: "feat/x" and "feat-x" map to the same folder.
    const block = list.out.split("\n\n").find((x) => x.split("\n")[0] === `worktree ${path}`);
    if (block) {
      const has = block.split("\n").find((l) => l.startsWith("branch "))?.slice(18);
      if (has && has !== branch) throw new Error(`${path} already holds branch ${has}.`);
      return path;
    }
    const exists = (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    const r = await git(base, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"]);
    if (!r.ok) throw new Error(r.err || "git worktree add failed.");
    return path;
  }

  // mode: "info" (notes, rename, archive, delete) or "launch" (start an agent for it). Again: closes.
  openTask(task, cx, mode = "info") {
    if (!task || (this.open === task.id && this.openMode === mode)) { this.open = null; this.launch = null; return; }
    this.open = task.id;
    this.openMode = mode;
    this.launch = null;
    if (mode === "info") {
      this.notes = this.input("Notes", task.notes ?? "", null, true);
      this.notes.set_auto_grow(2, 10);
      this.notes.on("blur", (_e, cx) => { const v = this.notes.value(); if (v !== (this.task(task.id)?.notes ?? "")) this.change((b) => { const tk = b.tasks.find((t) => t.id === task.id); if (tk) tk.notes = v; }, cx); });
      return;
    }
    const space = task.space ?? src.spaces().find((s) => s.active)?.id ?? src.spaces()[0]?.id;
    this.launch = {
      space, agent: null, busy: false, error: null,
      msg: this.input("First message (optional)", "", null, true),
      custom: this.input("Command, e.g. pi --model x", this.board.prefs?.customCommand ?? "", null),
      worktree: false,
      branch: this.input("Branch (new or existing)", "", null),
    };
    this.launch.branch.on("submit", (_e, cx) => this.commit(cx));
    this.launch.msg.set_auto_grow(2, 6);
    this.launch.msg.on("submit", (e, cx) => this.submitted(this.launch.msg, e, () => this.commit(cx), cx));
    this.focusBox(this.launch.msg);
    this.loadAgents(space, cx);
  }

  loadAgents(spaceId, cx) {
    const m = src.spaces().find((s) => s.id === spaceId)?.machine ?? "";
    if (this.known[m]) { this.launch.agent ??= this.known[m].find((k) => k.installed)?.key; return; }
    cx.spawn(async (cx) => {
      this.known[m] = await knownAgents({ on: m || null });
      if (this.launch) this.launch.agent ??= this.known[m].find((k) => k.installed)?.key;
      cx.notify();
    });
  }

  // True while dragging and just after a drop: the release also counts as a click, which must not act.
  wasDrag() { return !!this.drag || Date.now() - (this.dragEnd ?? 0) < 300; }

  goTo(a) {
    // The release happens in another view: forget the press, or coming back starts a drag.
    this.press = this.drag = this.over = null;
    run("pane.focus", { pane: a.pane });
    if (props()?.overlay) closeOverlay(props().overlay);
    else flip("main", false);
  }

  // Each box finishes only itself: opening another one (which replaces this.rename) still saves this one.
  startRename(kind, id, value, fresh = false) {
    const s = this.input("Name", value, null);
    const r = { kind, id, state: s, fresh };
    s.on("submit", (_e, cx) => this.finishRename(cx, r));
    s.on("blur", (_e, cx) => this.finishRename(cx, r));
    this.rename = r;
    this.focusBox(s);
  }

  // Esc: nothing is saved, and a column just added (still "New column") goes away again.
  cancelRename(cx) {
    const r = this.rename;
    if (!r) { this.focus.focus(); return; } // the filter box: esc hands the keyboard back to the board
    r.done = true;
    this.rename = null;
    if (r.kind === "column" && r.fresh) this.change((b) => { b.columns = b.columns.filter((c) => c.id !== r.id); }, cx);
    this.focus.focus();
  }

  finishRename(cx, r = this.rename) {
    if (!r || r.done) return;
    r.done = true;
    if (this.rename === r) this.rename = null;
    const v = r.state.value().trim();
    this.refocus(r.state);
    if (!v) {
      if (r.kind === "column" && r.fresh) this.change((b) => { b.columns = b.columns.filter((c) => c.id !== r.id); }, cx);
      cx.notify(); return;
    }
    // At the top, where its draft was, and selected, so e, a and i act on it straight away.
    if (r.kind === "new") {
      const id = newId("t");
      // Under a space filter it belongs to that space, so the filter keeps showing it.
      const sp = this.spaceFilter;
      this.change((b) => { const tk = this.newTask(b, r.id, v); tk.id = id; if (sp) tk.space = sp; this.place(b, id, r.id, 0); }, cx);
      const c = (this.cols ?? []).findIndex((x) => x.id === r.id);
      if (c >= 0) { this.follow = { id, c }; this.sel = { c, i: 0 }; }
    }
    if (r.kind === "task") this.change((b) => { const tk = b.tasks.find((t) => t.id === r.id); if (tk) tk.title = v; }, cx);
    if (r.kind === "column") this.change((b) => { const c = b.columns.find((x) => x.id === r.id); if (c) c.name = v; }, cx);
    if (r.kind === "inbox") {
      const a = src.agents().find((x) => x.address === r.id);
      if (!a) return;
      const id = newId("t");
      this.label(a.address, id);
      this.change((b) => { if (b.columns[0]) this.newTask(b, b.columns[0].id, v, a).id = id; }, cx);
      // Selected in its column, so a, i and L act on it at once.
      if ((this.cols ?? []).length > 1) { this.follow = { id, c: 1 }; this.sel = { c: 1, i: Infinity }; }
    }
    cx.notify();
  }

  // A draft card at the top of the column: Enter or leaving the field with text creates it, Esc cancels.
  addTask(col, _cx) {
    if (!col) return;
    const c = (this.cols ?? []).findIndex((x) => x.id === col);
    if (c >= 0) { this.sel = { c, i: 0 }; this.follow = null; this.pickAgent = null; }
    this.startRename("new", col, "");
  }

  ask(text, yes, extra) { this.bar = { kind: "confirm", text, yes, ...extra }; }

  columnAction(action, col, cx) {
    this.colMenu = null;
    const b = this.board;
    const i = b.columns.findIndex((c) => c.id === col);
    if (action === "rename") return this.startRename("column", col, b.columns[i].name);
    if (action === "delete") {
      if (b.columns.length <= 1) { this.bar = { kind: "note", text: "The board keeps at least one column." }; return; }
      if (b.tasks.some((t) => t.column === col)) { this.bar = { kind: "note", text: `Move its tasks first${this.filter || this.spaceFilter ? " (a filter may hide some)" : ""}.` }; return; }
      return this.change((b) => { b.columns.splice(i, 1); }, cx);
    }
    if (action === "left" || action === "right") {
      const j = action === "left" ? i - 1 : i + 1;
      if (j < 0 || j >= b.columns.length) return;
      if (this.sel.c === i + 1) this.sel.c = j + 1; // the selection goes with the column (cols has the Inbox first)
      return this.change((b) => { const [c] = b.columns.splice(i, 1); b.columns.splice(j, 0, c); }, cx);
    }
    if (action === "add" || action === "before") {
      const id = newId("c");
      this.change((b) => { b.columns.splice(action === "add" ? i + 1 : i, 0, { id, name: "New column" }); }, cx);
      this.startRename("column", id, "", true);
    }
  }

  // A textarea's "submit" comes for any Enter. On Shift+Enter the textarea inserts the line break itself
  // (as in Claude Code), so only a plain Enter acts.
  submitted(_state, e, act, _cx) {
    if (!e?.shift) act();
  }

  // Enter in notes or the first message: save the note, or launch from the open launch form.
  commit(cx) {
    if (this.notesEdit) this.saveNotes(cx);
    else if (this.launch && this.open && !this.launch.busy) { const tk = this.task(this.open); if (tk) cx.spawn((cx) => this.doLaunch(tk, cx)); }
    cx.notify();
  }

  // ---- keys ----

  key(e, cx) {
    const k = e.keystroke;
    if (this.typing) {
      if (k === "escape") {
        // Esc on notes: unchanged closes; changed asks before discarding (a long note mustn't be lost to a
        // stray key). Esc cancels a rename.
        const ed = this.notesEdit;
        if (ed && ed.state.value().trim() === ed.before.trim()) this.cancelNotes(ed.id, ed.before, cx);
        else if (ed) {
          ed.asking = true; // the field loses the keyboard now; that blur must not save
          this.focus.focus();
          this.ask("Discard your changes to the note?", (cx) => this.cancelNotes(ed.id, ed.before, cx), {
            no: () => { ed.asking = false; this.focusBox(ed.state); },
          });
        } else this.cancelRename(cx);
        cx.notify();
      }
      return;
    }
    const cols = this.cols ?? [];
    const col = cols[this.sel.c];
    const item = col?.items[this.sel.i];
    // A task just moved by key may not be in its new column yet (the store writes in the background):
    // keys act on it, not on whatever the selection landed on meanwhile, so H/L can be pressed repeatedly.
    const pending = this.follow ? this.task(this.follow.id) : null;
    if (!pending) this.follow = null;
    const task = pending ?? (item?.kind === "task" ? item.task : null);
    const clamp = () => { this.sel.c = Math.max(0, Math.min(cols.length - 1, this.sel.c)); this.sel.i = Math.max(0, Math.min((cols[this.sel.c]?.items.length ?? 1) - 1, this.sel.i)); };
    // Moves the selected task to column j (at its end) and keeps it selected; an Inbox agent becomes a new
    // task there, named after it, as when it's dropped on a column.
    const sendTo = (j) => {
      if (j < 1 || j >= cols.length) return;
      if (task) {
        this.change((b) => this.place(b, task.id, cols[j].id, Infinity), cx);
        this.follow = { id: task.id, c: j };
      } else if (item?.kind === "inbox") {
        const a = item.agent;
        const id = newId("t");
        this.label(a.address, id);
        this.change((b) => { this.newTask(b, cols[j].id, agentName(a), a).id = id; this.place(b, id, cols[j].id, Infinity); }, cx);
        this.follow = { id, c: j };
      } else return;
      this.sel = { c: j, i: Infinity };
    };
    const moveCol = (d) => sendTo((pending ? this.follow.c : this.sel.c) + d);
    if (this.bar?.kind === "confirm") {
      if (k === "y" || k === "enter") {
        if (this.bar.neverOn) this.change((bd) => { bd.prefs = { ...bd.prefs, confirmDone: false }; }, cx);
        this.bar.yes(cx); this.bar = null;
      }
      else if (k === "a" && this.bar.never) this.bar.neverOn = !this.bar.neverOn; // "always": Don't ask again
      else if (k === "n" || k === "escape") { const no = this.bar.no; this.bar = null; no?.(cx); }
      cx.notify(); return;
    }
    if (this.archiveView) { this.archiveKey(k, cx); return; }
    // The open column menu: its letters, esc closes it.
    if (this.colMenu) {
      const hit = COL_MENU.find((x) => x[2] === k);
      const id = this.colMenu;
      this.colMenu = null;
      if (hit) this.columnAction(hit[0], id, cx);
      cx.notify(); return;
    }
    if (this.bar?.kind === "move") {
      const n = parseInt(k, 10);
      if (n >= 1 && n < cols.length) sendTo(n);
      this.bar = null; cx.notify(); return;
    }
    // The open launch form: s / p open the space / agent picker (j k, enter picks, esc closes it), w toggles
    // a new worktree, i (or tab) goes back to the message, enter launches. Other keys work as usual.
    if (this.launch && this.open) {
      const L = this.launch;
      const pk = L.pick && L.pickers?.[L.pick];
      if (pk) {
        if (k === "j" || k === "down") L.hi = Math.min(pk.options.length - 1, (L.hi ?? 0) + 1);
        else if (k === "k" || k === "up") L.hi = Math.max(0, (L.hi ?? 0) - 1);
        else if (k === "enter") { const o = pk.options[L.hi ?? 0]; L.pick = null; if (o) pk.onPick(o, cx); }
        else if (k === "escape") L.pick = null;
        cx.notify(); return;
      }
      const openPicker = (id) => { const p = L.pickers?.[id]; if (!p) return; L.pick = id; L.hi = Math.max(0, p.options.findIndex((o) => o.key === p.value)); };
      const tk = this.task(this.open);
      const hit = { s: () => openPicker(`psp-${this.open}`), p: () => openPicker(`pag-${this.open}`),
        w: () => { L.worktree = !L.worktree; if (L.worktree) this.focusBox(L.branch); },
        i: () => this.focusBox(L.msg),
        enter: () => { if (tk && !L.busy) cx.spawn((cx) => this.doLaunch(tk, cx)); } }[k];
      if (hit) { hit(); cx.notify(); return; }
    }
    // Adding an Inbox agent to a task (t): the usual keys move to a task, enter adds it there, esc cancels.
    if (this.attach) {
      if (k === "escape") { this.attach = null; cx.notify(); return; }
      if (k === "enter") {
        const at = this.attach;
        this.attach = null;
        const a = src.agents().find((x) => x.address === at.address);
        if (task && a) {
          this.label(a.address, task.id);
          this.change((b) => { const tk = b.tasks.find((x) => x.id === task.id); if (tk && !tk.agents.some((r) => r.address === a.address)) tk.agents.push(this.rowFrom(a)); }, cx);
        }
        cx.notify(); return;
      }
      if (!NAV.includes(k)) return;
    }
    // Picking one of the selected task's agents (enter): j k move, enter opens it, anything else leaves.
    if (this.pickAgent != null && task) {
      const rows = this.shownRows(task);
      const x = rows[this.pickAgent];
      if (k === "j" || k === "down") { this.pickAgent = Math.min(rows.length - 1, this.pickAgent + 1); cx.notify(); return; }
      if (k === "k" || k === "up") { this.pickAgent = Math.max(0, this.pickAgent - 1); cx.notify(); return; }
      if (k === "enter") { this.pickAgent = null; this.actOnRow(task, x, cx); cx.notify(); return; }
      if (k === "a") { this.pickAgent = null; this.openTask(task, cx, "launch"); cx.notify(); return; }
      // 1–9: open that link of the picked agent (numbered newest first).
      const n = parseInt(k, 10);
      if (n >= 1 && n <= 9 && x) { const l = rowLinks(x.r, true)[n - 1]; if (l) openUrl(l.u); cx.notify(); return; }
      // d or x: this agent leaves the task (back to the Inbox; its terminal keeps running). Never the task.
      if ((k === "x" || k === "d") && x) {
        this.unlist(task.id, x.r.address, cx);
        this.pickAgent = Math.max(0, Math.min(this.pickAgent, rows.length - 2));
        if (rows.length <= 1) this.pickAgent = null;
        cx.notify(); return;
      }
      // Any other key leaves agent selection. Only moving to another column carries on; card keys (delete,
      // archive, move...) are swallowed, so a key meant for the agent can't act on the whole task.
      this.pickAgent = null;
      if (!["h", "l", "left", "right"].includes(k)) { cx.notify(); return; }
    }
    const helpWasOpen = this.bar?.kind === "help";
    this.bar = null;
    // Moving the selection yourself stops it following a moved task.
    if (NAV.includes(k)) this.follow = null;
    switch (k) {
      case "h": case "left": this.sel.c--; break;
      case "l": case "right": this.sel.c++; break;
      case "j": case "down": this.sel.i++; break;
      case "k": case "up": this.sel.i--; break;
      case "g": this.sel.i = 0; break;
      case "G": case "shift-g": this.sel.i = Infinity; break;
      case "H": case "shift-h": case "shift-left": moveCol(-1); break;
      case "L": case "shift-l": case "shift-right": moveCol(1); break;
      case "K": case "shift-k": case "shift-up":
        // Relative to the card shown next to it, so cards a filter hides don't count.
        if (task && !pending && col.id !== INBOX && this.sel.i > 0) { const ids = this.order(col); this.reorder(col, ids[this.sel.i], ids[this.sel.i - 1], null, this.sel.i - 1, cx); this.sel.i--; } break;
      case "J": case "shift-j": case "shift-down":
        if (task && !pending && col.id !== INBOX && this.sel.i < col.items.length - 1) { const ids = this.order(col); this.reorder(col, ids[this.sel.i], null, ids[this.sel.i + 1], this.sel.i + 1, cx); this.sel.i++; } break;
      case "m": if (task || item?.kind === "inbox") this.bar = { kind: "move" }; break;
      case "space": {
        if (!task) break;
        const done = this.doneColumn();
        if (!done) { this.bar = { kind: "note", text: "No Done column: name a column Done." }; break; }
        if (task.column === done.id) break;
        const go = (cx) => this.change((b) => this.place(b, task.id, done.id, Infinity), cx);
        if (this.board.prefs?.confirmDone === false) go(cx);
        else this.ask(`Move "${task.title}" to ${done.name}?`, go, { never: true });
        break;
      }
      case "n": if (col && col.id !== INBOX) this.addTask(col.id, cx); break;
      case "c": if (col && col.id !== INBOX) this.colMenu = col.id; break;
      case "e":
        if (task) this.startRename("task", task.id, task.title);
        else if (item?.kind === "inbox") this.startRename("inbox", item.id, agentName(item.agent));
        break;
      case "enter":
        if (task && task.agents.length) this.pickAgent = 0;
        else if (item?.kind === "inbox") this.goTo(item.agent);
        break;
      // One thing at a time: the launch form, then the text filter, then the space filter.
      case "escape":
        if (this.open) { this.open = null; this.launch = null; }
        else if (this.filter) { this.filterState.set_value(""); this.filter = ""; }
        else this.spaceFilter = null;
        break;
      case "a": if (task) this.openTask(task, cx, "launch"); break;
      case "i": if (task) this.startNotes(task); break;
      case "x": if (task) this.shelve(task, cx); break;
      case "d": if (task) this.ask(`Delete "${task.title}"?`, (cx) => this.shelve(task, cx, true)); break;
      case "u": this.undo(cx); break;
      case "U": case "shift-u": case "ctrl-r": this.undo(cx, true); break;
      case "A": case "shift-a": this.archiveView = { i: 0 }; this.open = null; this.launch = null; break;
      case "t":
        // An Inbox agent onto an existing task: pick the task with the usual keys, enter adds it.
        if (item?.kind === "inbox") { this.attach = { address: item.id, name: agentName(item.agent) }; this.sel = { c: Math.min(1, cols.length - 1), i: 0 }; }
        break;
      case "X": case "shift-x": this.askClearDone(); break;
      case "/": this.focusBox(this.filterState); break;
      case "s": case "S": case "shift-s": {
        // The space chips, in turn: s forward, S back, through "All".
        const ids = [null, ...src.spaces().map((x) => x.id).filter((id) => this.board.tasks.some((tk) => this.spacesOf(tk, this.ags).has(id)) || (this.inboxAll ?? []).some((a) => a.space === id))];
        const at = Math.max(0, ids.indexOf(this.spaceFilter));
        this.spaceFilter = ids[(at + (k === "s" ? 1 : ids.length - 1)) % ids.length];
        break;
      }
      case "?": case "shift-/": if (!helpWasOpen) this.bar = { kind: "help" }; break;
      default: {
        const n = parseInt(k, 10);
        if (task && n >= 1 && n <= 9) {
          this.actOnRow(task, this.shownRows(task)[n - 1], cx);
        }
        return;
      }
    }
    clamp();
    cx.notify();
  }

  clearDone(cx) {
    const done = this.doneColumn()?.id;
    if (!done) return;
    this.change((b) => {
      const now = Date.now();
      b.archive.push(...b.tasks.filter((t) => t.column === done).map((t) => ({ ...t, archived: now })));
      b.tasks = b.tasks.filter((t) => t.column !== done);
    }, cx);
  }

  // ---- drawing ----

  // An outline for an agent that's waiting on you: done (finished, not looked at yet) strongest, needs you in
  // its own color, idle (finished and seen) faint. A working agent's is part yellow and breathes (agentRow).
  tone(t, s) {
    if (s === "blocked") return alpha(t.blocked, "cc");
    if (s === "done") return alpha(t.done, "cc");
    if (s === "idle") return alpha(t.done, "55");
    if (s === "working") return alpha(t.working, "66"); // the floor of its breathing outline
    return null;
  }

  status(t, s, reason) {
    if (s === "working") return svg(`${ICONS}/spinner.svg`).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (s === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(alpha(t.blocked, "26")).text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you").when(!!reason, (el) => el.id(`r-${Math.random()}`).tooltip(reason));
    if (s === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    if (s === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    return null;
  }

  cacheBadge(t, term, now) {
    const w = warmth(this.cache.info(term), now);
    if (!w) return null;
    if (w.cold) return div().flex_none().text_size(10.5).text_color(t.dim).child("cold");
    const c = warmthColor(t, w.share);
    // Nearly out (the red end): it breathes, like a working agent's outline, a little faster.
    return div().flex_none().px(5).h(16).rounded(4).bg(alpha(c, "33")).text_color(c).text_size(10.5).font_semibold().flex().items_center()
      .when(w.share < 0.2, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }))
      .child(w.text);
  }

  agentRow(t, row, st, now, hovered, taskId, picked, num, showX, hints, here = () => {}) {
    const live = st.state === "live";
    const resumable = st.state === "ended" && !!row.session && !st.elsewhere;
    const a = st.agent;
    const sp = src.spaces().find((s) => s.id === (a?.space ?? row.space));
    const pic = icon(a?.program, 14, t.foreground);
    // Each agent is its own faint block (live ones tinted), so neighbours read apart without inner borders.
    return v_flex().id(`ar-${row.address}`).gap(4).px(4).py(4).rounded(6).text_size(12)
      .when(st.state !== "ended" && !picked, (el) => el.bg(alpha(t.foreground, "0a")))
      // Always a 1px border on live rows (clear while working), so a status change doesn't shift the row.
      .when(live, (el) => el.border(1).border_color(this.tone(t, a.status) ?? alpha(t.foreground, "00")))
      // Working: a yellow outline that breathes between part and full yellow: a full one fading in and out over
      // the row's own part-yellow border (Herdr animates opacity natively; a line running round isn't possible).
      .when(live && a.status === "working", (el) => el.relative().child(div().absolute().top(-1).left(-1).right(-1).bottom(-1)
        .rounded(6).border(1).border_color(t.working).loop("opacity", { from: 0, to: 1, period: 1600 })))
      .when(picked, (el) => el.bg(t.selected))
      .when(live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        // A row can be dragged to another task, a column (a new task) or the Inbox (out of its task).
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.focus.focus();
          here();
          this.press = { kind: "agent", from: taskId, id: row.address, x: e.position.x, y: e.position.y, dx: e.local_position?.x ?? 0, dy: e.local_position?.y ?? 0, title: agentName(a) };
          cx.notify();
        })
        .on_click((_e, cx) => { cx.stop_propagation(); if (!this.wasDrag()) this.goTo(a); }))
      // An ended Claude agent: dashed, and a click resumes its conversation in a new tab.
      .when(resumable, (el) => el.border(1).border_dashed().border_color(t.input).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip("Resume this conversation")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); here(); if (!this.wasDrag()) cx.spawn((cx) => this.revive(taskId, row, cx)); }))
      // The top: number, icon, name and space, status and cache, ×. The links go under it, across the row.
      .child(h_flex().gap(6).items_start()
      .child(div().pt(1).w(8).flex_none().child(this.kbd(t, num, hints)))
      .child(div().pt(1).w(14).flex_none().when(!!pic, (el) => el.child(pic)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_color(live ? t.foreground : t.dim).child(live ? agentName(a) : (row.name || this.task(taskId)?.title || row.address)))
        .child(h_flex().gap(5).items_center().min_w(0)
          .when(!!sp, (el) => el.child(spaceTile(t, sp, 13)))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(sp?.name ?? ""))
          .when(live && !!waited(a.status, st.term, now), (el) => el.child(div().flex_none().text_size(10.5)
            .text_color(a.status === "blocked" ? t.blocked : t.dim).child(`· ${waited(a.status, st.term, now)}`))))
        )
      // Status on top, cache time under it, right-aligned together.
      .child(v_flex().flex_none().gap(2).items_end()
        .child(h_flex().h(16).items_center()
          .when(live, (el) => el.child(this.status(t, a.status, this.cache.info(st.term)?.waitingFor) ?? div()))
          .when(st.state === "unknown", (el) => el.child(div().text_size(10.5).text_color(t.dim).child("away")))
          .when(st.state === "ended", (el) => el.child(div().text_size(10.5).text_color(resumable ? t.muted : t.dim).child(resumable ? "↻ resume" : st.elsewhere ? "on another task" : "ended"))))
        .when(live, (el) => el.child(this.cacheBadge(t, st.term, now) ?? div())))
      .child(h_flex().h(16).flex_none().gap(3).items_center()
        .child(this.kbd(t, "x", showX))
        // Always there (keeps the row's width); visible on hover or while this row is picked.
        .child(div().id(`rm-${row.address}`).px(2).text_color(t.dim).when(!(hovered || showX), (el) => el.opacity(0)).hover((s) => s.text_color(t.foreground)).tooltip("Back to the Inbox")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); here(); this.unlist(taskId, row.address, cx); })
          .child("×"))))
      .when(!!row.links?.length, (el) => el.child(this.linksBlock(t, row, picked, now)));
  }

  // The links an agent printed (PRs, Jira issues), across the row under its name, from the name's left edge.
  // Unpicked: the newest of each repository, one chip per line ("web-app #412"). Picked: every link, grouped
  // under its repository's name, each a numbered line ("1  #412  3h ago"; 1–9 opens it); a link first seen an
  // hour or more before its repository's latest is dimmed. A chip's tooltip is its whole link.
  linksBlock(t, row, picked, now) {
    const chip = (l, label, i, fresh) => div().id(`pr-${row.address}-${i}`).min_w(0).px(5).h(16).rounded(4).flex().items_center()
      .text_size(10.5).font_semibold().text_color(fresh ? t.accent : t.muted)
      .bg(alpha(fresh ? t.accent : t.foreground, "1a")).cursor_pointer().hover((s) => s.bg(alpha(t.accent, "33")))
      .tooltip(l.u)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(l.u); })
      .child(div().truncate().child(label));
    if (!picked) {
      return v_flex().pl(34).gap(3).items_start().min_w(0)
        .children(rowLinks(row, false).map((l, i) => h_flex().max_w_full().min_w(0).child(chip(l, prLabel(l.u), i, true))));
    }
    let n = 0;
    return v_flex().pl(20).gap(6).min_w(0).children(linkGroups(row).map((g) => v_flex().gap(3).min_w(0)
      .child(div().pl(14).truncate().text_size(10.5).text_color(t.dim).child(g.name))
      .children(g.links.map((l) => {
        const i = n++;
        // Dimmed only when its repository has a link first seen an hour or more after it (an earlier round,
        // most likely); links seen close together (a dev and a prod PR, say) all stay lit. Unknown age: lit.
        const latest = Math.max(...g.links.map((x) => x.at ?? 0));
        return h_flex().gap(6).items_center().min_w(0).when(i >= 9, (el) => el.opacity(0.6))
          .child(div().w(8).flex_none().child(this.kbd(t, i < 9 ? String(i + 1) : "")))
          .child(chip(l, shortLabel(l.u), i, !l.at || latest - l.at < 3600000))
          .when(!!l.at, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${ago(l.at, now)} ago`)));
      }))));
  }

  // Hover bookkeeping shared by cards and column bodies while dragging.
  track(e, over, cx) {
    this.mouse = e.position;
    if (this.press && !this.drag && Math.abs(e.position.x - this.press.x) + Math.abs(e.position.y - this.press.y) > 4) this.drag = true;
    if (this.drag) { this.over = over; cx.notify(); }
    cx.stop_propagation();
  }

  // A task's agent rows as shown: live (and away) first, then ended; each with its state.
  shownRows(task) {
    const rows = task.agents.map((r) => ({ r, st: this.rowState(task, r, this.terms, this.ags) }));
    return [...rows.filter((x) => x.st.state !== "ended"), ...rows.filter((x) => x.st.state === "ended")];
  }

  // What enter or a digit does to a row: go to a live agent, resume an ended Claude one.
  actOnRow(task, x, cx) {
    if (!x) return;
    if (x.st.state === "live") this.goTo(x.st.agent);
    else if (x.st.state === "ended" && x.r.session && !x.st.elsewhere) cx.spawn((cx) => this.revive(task.id, x.r, cx));
  }

  startNotes(task) {
    const s = this.input("Notes", task.notes ?? "", null, true);
    s.set_auto_grow(2, 12);
    const ed = { id: task.id, state: s, before: task.notes ?? "" };
    s.on("blur", (_e, cx) => this.saveNotes(cx, ed));
    s.on("submit", (e, cx) => this.submitted(s, e, () => this.saveNotes(cx, ed), cx));
    this.notesEdit = ed;
    this.focusBox(s);
    // The cursor goes after the text, where you'd continue typing.
    const end = (task.notes ?? "").length;
    s.set_selected_range({ start: end, end });
  }

  // Saves the open notes editor (Save, or clicking away). Esc clears notesEdit first, so nothing is saved.
  saveNotes(cx, ed = this.notesEdit) {
    if (!ed || ed.asking || ed.done) return;
    ed.done = true;
    if (this.notesEdit === ed) this.notesEdit = null;
    const v = ed.state.value().trim();
    if (v !== (this.task(ed.id)?.notes ?? "")) this.change((b) => { const tk = b.tasks.find((t) => t.id === ed.id); if (tk) tk.notes = v; }, cx);
    this.refocus(ed.state);
    cx.notify();
  }

  // Cancel: back to the notes as they were. Clicking the button may already have saved (the field lost
  // the keyboard first), so this restores rather than just discards.
  cancelNotes(id, before, cx) {
    if (this.notesEdit) this.notesEdit.done = true;
    this.notesEdit = null;
    if ((this.task(id)?.notes ?? "") !== before) this.change((b) => { const tk = b.tasks.find((t) => t.id === id); if (tk) tk.notes = before; }, cx);
    this.focus.focus();
  }

  // A key hint: a faint letter beside its control, not a box (a box reads as a key to press with it).
  // Hover and selection never change layout, only visibility: a hidden hint keeps its space.
  kbd(t, key, show = true) {
    return div().flex_none().text_size(10).text_color(alpha(t.dim, "b0")).when(!show, (el) => el.opacity(0)).child(key);
  }

  card(t, col, item, i, now) {
    // While a new task is typed, its draft is the selection.
    const selected = this.sel.c === col.index && this.sel.i === i && this.rename?.kind !== "new";
    const lifted = this.drag && this.press?.id === item.id;
    const hovered = this.hoverCard === item.id;
    // A click anywhere in the card (its buttons too) selects it, so the next key acts on the card you clicked.
    const here = () => { this.sel = { c: col.index, i }; this.follow = null; this.colMenu = null; if (this.cardMenu !== item.id) this.cardMenu = null; };
    const base = v_flex().id(`card-${item.id}`).w_full().p(10).gap(6).rounded(8).border(1).bg(t.surface)
      .border_color(selected ? t.accent : t.border)
      .when(lifted, (el) => el.opacity(0.35))
      .on_hover((h, cx) => { if (h) this.hoverCard = item.id; else if (this.hoverCard === item.id) this.hoverCard = null; cx.notify(); })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.focus.focus();
        here();
        this.press = { kind: item.kind, id: item.id, x: e.position.x, y: e.position.y, dx: e.local_position?.x ?? 0, dy: e.local_position?.y ?? 0, title: item.kind === "task" ? item.task.title : agentName(item.agent) };
        this.sel = { c: col.index, i };
        this.pickAgent = null;
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        const h = e.bounds?.height ?? 40;
        const local = e.position.y - (e.bounds?.y ?? 0);
        const attach = (this.press?.kind === "inbox" || this.press?.kind === "agent") && item.kind === "task" && local > h * 0.25 && local < h * 0.75;
        this.track(e, attach ? { task: item.id } : { col: col.id, index: local < h / 2 ? i : i + 1 }, cx);
      })
      .on_click((_e, cx) => {
        if (this.wasDrag()) return;
        if (item.kind === "inbox") this.goTo(item.agent);
        cx.notify();
      });
    const attachHere = this.drag && this.over?.task === item.id;
    if (item.kind === "inbox") {
      const a = item.agent;
      const term = this.terms.get(a.address);
      return base.border_color(selected ? t.accent : this.tone(t, a.status) ?? t.input).bg(t.background)
        .child(this.rename?.kind === "inbox" && this.rename.id === a.address ? this.field(t, this.rename.state) : div().text_size(13).text_color(t.foreground).child(agentName(a)))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .when(!!icon(a.program, 13, t.foreground), (el) => el.child(icon(a.program, 13, t.foreground)))
          .child(spaceTile(t, src.spaces().find((s) => s.id === a.space), 13))
          .child(div().flex_1().truncate().child(`${a.space_name ?? ""}${waited(a.status, term, now) ? ` · ${waited(a.status, term, now)}` : ""}`))
          .child(this.cacheBadge(t, term, now) ?? div())
          .child(this.status(t, a.status, this.cache.info(term)?.waitingFor) ?? div()));
    }
    const task = item.task;
    const launching = this.open === task.id;
    // Key letters only on the selected card (keys act on it); a hovered one shows its buttons, not their keys.
    const hints = selected;
    const buttons = selected || hovered;
    const shownRows = this.shownRows(task);
    const picked = selected && this.pickAgent != null ? shownRows[this.pickAgent]?.r.address : null;
    const pencil = (id, tip, click, key) => this.iconButton(t, id, "square-pen", tip, click, key, hints).when(!buttons, (el) => el.opacity(0));
    const menuOpen = this.cardMenu === task.id;
    return base.when(attachHere, (el) => el.border_color(t.accent).bg(t.selected))
      .child(this.rename?.kind === "task" && this.rename.id === task.id
        ? this.field(t, this.rename.state)
        : h_flex().gap(2).items_start()
          .child(div().id(`title-${task.id}`).flex_1().min_w(0).pr(4).text_size(13).font_medium().text_color(t.foreground)
            .on_click((e, cx) => { if (e.click_count >= 2 && !this.wasDrag()) { this.startRename("task", task.id, task.title); cx.notify(); } })
            .child(task.title))
          .child(pencil(`ren-${task.id}`, "Rename (e)", () => { here(); this.startRename("task", task.id, task.title); }, "e"))
          .child(this.iconButton(t, `launch-${task.id}`, "plus", "Launch an agent (a)", (cx) => { here(); this.openTask(task, cx, "launch"); }, "a", hints))
          .child(div().id(`cmenu-${task.id}`).px(5).rounded(4).text_size(13).text_color(menuOpen ? t.foreground : t.dim).cursor_pointer().tooltip("More")
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); here(); this.cardMenu = menuOpen ? null : task.id; cx.notify(); }).child("⋯")))
      .when(menuOpen, (el) => el.child(this.menu(t, `cm-${task.id}`, [
        ["Archive  (x)", (cx) => this.shelve(task, cx)],
        ["Delete  (d)", () => this.ask(`Delete "${task.title}"?`, (cx) => this.shelve(task, cx, true)), true],
      ], () => { this.cardMenu = null; })))
      // Notes: a faint box that is always there; a click edits it in place.
      .child(this.notesEdit?.id === task.id
        ? v_flex().gap(4).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.notesEdit.state).px(8).py(6).rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground).text_size(12))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().text_size(10.5).text_color(t.dim).child("⇧↵ new line"))
            .child(this.chip(t, `ncancel-${task.id}`, "Cancel", false, (cx) => this.cancelNotes(task.id, this.notesEdit?.before ?? "", cx)))
            .child(this.chip(t, `nsave-${task.id}`, "Save  ↵", true, (cx) => this.saveNotes(cx))))
        : div().id(`notes-${task.id}`).px(8).py(5).rounded(6).border(1).border_color(hovered ? t.border : alpha(t.border, "00")).bg(alpha(t.background, "80"))
          .text_size(12).text_color(task.notes ? t.muted : t.dim).cursor_pointer()
          .hover((s) => s.border_color(t.input))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); here(); this.startNotes(task); cx.notify(); })
          .child(h_flex().gap(6).items_start()
            .child(div().flex_1().min_w(0).child(task.notes || "Add notes…"))
            .child(this.kbd(t, "i", hints))))
      .when(shownRows.length > 0, (el) => el.child(v_flex().gap(4).children(shownRows.map((x, n) => this.agentRow(t, x.r, x.st, now, hovered, task.id, x.r.address === picked, n < 9 ? String(n + 1) : "", picked === x.r.address, hints && !picked, here)))))
      .when(launching, (el) => el.child(this.details(t, task)));
  }

  // A small vertical menu: [label, action, danger?]; done runs after any pick.
  menu(t, id, items, done) {
    return v_flex().p(3).rounded(6).border(1).border_color(t.border).bg(t.popover)
      .children(items.map(([l, act, danger], k) => div().id(`${id}-${k}`).h(24).px(8).flex().items_center().rounded(4).text_size(12).cursor_pointer()
        .text_color(danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); done(); act(cx); cx.notify(); })
        .child(l)));
  }

  // A text field inside a card or header: a press on it must not reach the card or the board (which take the keyboard).
  field(t, state) {
    return div().w_full().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h(28).px(8).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground).text_size(13));
  }

  chip(t, id, label, on, click) {
    return div().id(id).flex_none().px(7).h(22).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
      .bg(on ? t.accent : t.raised).text_color(on ? t.accent_foreground : t.foreground)
      .hover((s) => s.bg(on ? t.accent : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); cx.notify(); })
      .child(label);
  }

  iconButton(t, id, name, tip, click, key, showKey = true) {
    return h_flex().id(id).flex_none().gap(2).items_center().p(3).rounded(4).text_color(t.dim).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); cx.notify(); })
      .child(svg(`${ICONS}/${name}.svg`).size(13))
      .when(!!key, (el) => el.child(this.kbd(t, key, showKey)));
  }

  // A one-line picker: shows the choice; a click lists the options below it.
  picker(t, id, value, options, onPick) {
    const open = this.launch?.pick === id;
    // The keyboard can open it (its key), so the form remembers each picker's options.
    this.launch.pickers = { ...(this.launch.pickers ?? {}), [id]: { options, onPick, value: value?.key } };
    const row = (o, i) => div().id(`${id}-${o.key}`).h(24).px(8).flex().items_center().rounded(4).text_size(12).truncate().cursor_pointer()
      .text_color(o.key === value?.key ? t.foreground : t.muted).when(o.key === value?.key, (el) => el.bg(t.selected))
      .when(open && this.launch.hi === i, (el) => el.bg(t.hover).text_color(t.foreground))
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.launch.pick = null; onPick(o, cx); cx.notify(); })
      .child(o.label);
    return v_flex().flex_1().min_w(0).gap(2)
      .child(h_flex().id(id).h(26).px(8).gap(4).items_center().rounded(6).border(1).border_color(open ? t.accent : t.input).bg(t.background).cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.launch.pick = open ? null : id; cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(value ? t.foreground : t.dim).child(value?.label ?? "…"))
        .child(svg(`${ICONS}/chevron-down.svg`).size(11).flex_none().text_color(t.dim)))
      .when(open, (el) => el.child(v_flex().id(`${id}-list`).max_h(180).overflow_y_scroll().p(3).rounded(6).border(1).border_color(t.border).bg(t.popover).children(options.map((o, i) => row(o, i)))));
  }

  details(t, task) {
    const L = this.launch;
    const sp = src.spaces().find((s) => s.id === L?.space);
    const spaceOpts = src.spaces().map((s) => ({ key: s.id, label: s.machine ? `${s.machine} · ${s.name}` : s.name }));
    const agentOpts = [...(this.known[sp?.machine ?? ""] ?? []).filter((k) => k.installed).map((k) => ({ key: k.key, label: k.name })), { key: CUSTOM, label: "Custom command…" }];
    const info = this.openMode === "info";
    const label = (s) => div().text_size(11).text_color(t.dim).child(s);
    const hinted = (key, top, el) => h_flex().gap(6).items_start()
      .child(div().w(8).flex_none().pt(top).child(this.kbd(t, key, !this.typing)))
      .child(div().flex_1().min_w(0).child(el));
    const box = (state) => Textarea.new(state).px(8).py(6).rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12.5);
    const link = (id, text, click) => div().id(id).text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); cx.notify(); }).child(text);
    return v_flex().id(`det-${task.id}`).gap(6).pt(8).border_t(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(info, (el) => el.child(label("Notes")).child(box(this.notes)))
      .when(!!L, (el) => el
        .child(label("Launch an agent"))
        // One control per row, its key hint in a fixed gutter on the left, so every control starts at the same edge.
        .child(hinted("s", 23, v_flex().gap(3).child(label("Space")).child(this.picker(t, `psp-${task.id}`, spaceOpts.find((o) => o.key === L.space), spaceOpts, (o, cx) => { L.space = o.key; L.agent = null; this.loadAgents(o.key, cx); }))))
        .child(hinted("p", 23, v_flex().gap(3).child(label("Agent")).child(this.picker(t, `pag-${task.id}`, agentOpts.find((o) => o.key === L.agent), agentOpts, (o) => { L.agent = o.key; }))))
        .when(L.agent === CUSTOM, (el) => el.child(hinted("", 0, Input.new(L.custom).h(26).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12))))
        .child(hinted("i", 7, box(L.msg)))
        .child(hinted("w", 4, h_flex().gap(6).items_center()
          .child(this.chip(t, `wt-${task.id}`, `${L.worktree ? "☑" : "☐"} New worktree`, false, () => { L.worktree = !L.worktree; if (L.worktree) this.focusBox(L.branch); }))
          .when(L.worktree, (el) => el.child(div().flex_1().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(L.branch).h(26).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12))))))
        .child(h_flex().gap(8).items_center()
          .when(info === false && !!task.notes, (el) => el.child(link(`usenotes-${task.id}`, "Use notes", () => L.msg.set_value(task.notes))))
          .child(div().flex_1())
          .child(this.chip(t, `go-${task.id}`, L.busy ? "Launching…" : "Launch  ↵", true, (cx) => { if (!L.busy) cx.spawn((cx) => this.doLaunch(task, cx)); })))
        .when(!!L.error, (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(L.error))))
      .when(info, (el) => el.child(h_flex().gap(12).pt(2).justify_end()
        .child(link(`arch-${task.id}`, "Archive", (cx) => { this.open = null; this.shelve(task, cx); }))
        .child(link(`del-${task.id}`, "Delete", () => { this.ask(`Delete "${task.title}"?`, (cx) => { this.open = null; this.shelve(task, cx, true); }); }))));
  }

  column(t, col, now) {
    const inbox = col.id === INBOX;
    const selCol = this.sel.c === col.index;
    const filtering = !!this.filter || !!this.spaceFilter;
    const draft = this.rename?.kind === "new" && this.rename.id === col.id;
    // The Inbox has no order to drop into: no line there.
    const showLine = (i) => !inbox && this.drag && this.press?.kind && this.over?.col === col.id && this.over.index === i;
    // Drawn over the gap between cards, taking no room: a line that pushed the cards down moved the card out
    // from under the mouse, which moved the line, which moved the card back (it flickered).
    // Above the first card and below the last there's no gap (the scroll area would clip it): just inside.
    const line = (edge, inside) => div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
      .when(edge === "top", (el) => el.top(inside ? 0 : -4)).when(edge === "bottom", (el) => el.bottom(inside ? 0 : -4));
    const cards = [];
    const last = col.items.length - 1;
    col.items.forEach((item, i) => {
      const before = showLine(i);
      const after = i === last && (showLine(col.items.length) || showLine(Infinity));
      const card = this.card(t, col, item, i, now);
      cards.push(before || after ? div().relative().w_full().child(card).when(before, (el) => el.child(line("top", i === 0))).when(after, (el) => el.child(line("bottom", true))) : card);
    });
    if (!col.items.length && (showLine(0) || showLine(Infinity))) cards.push(div().relative().h(2).w_full().child(line(null)));
    if (this.rename?.kind === "new" && this.rename.id === col.id) {
      cards.unshift(v_flex().id(`draft-${col.id}`).p(10).rounded(8).border(1).border_color(t.accent).bg(t.surface)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.field(t, this.rename.state))
        .child(div().pt(4).text_size(11).text_color(t.dim).child("Enter to add · Esc to cancel")));
    }
    const header = h_flex().id(`ch-${col.id}`).h(32).px(4).gap(4).items_center().flex_none()
      .child(this.rename?.kind === "column" && this.rename.id === col.id
        ? this.field(t, this.rename.state)
        : div().min_w(0).truncate().text_size(12).font_medium().text_color(selCol ? t.foreground : t.muted).child(col.name))
      .child(div().text_size(11).text_color(t.dim).child(String(col.items.length)))
      .child(div().flex_1())
      .when(!inbox && col.id === this.doneColumn()?.id && col.items.length > 0, (el) => el.child(this.chip(t, `clear-${col.id}`, "Clear", false, () => this.askClearDone())))
      .when(!inbox, (el) => el
        .child(div().id(`cmb-${col.id}`).px(5).rounded(4).text_size(13).text_color(this.colMenu === col.id ? t.foreground : t.dim).cursor_pointer().tooltip("Column")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.colMenu = this.colMenu === col.id ? null : col.id; cx.notify(); }).child("⋯"))
        .child(this.iconButton(t, `add-${col.id}`, "plus", "New task (n)", (cx) => this.addTask(col.id, cx), "n", this.sel.c === col.index)));
    const menu = this.colMenu === col.id
      ? v_flex().mx(4).mb(6).p(3).rounded(6).border(1).border_color(t.border).bg(t.popover)
        .children(COL_MENU
          .map(([a, l, key]) => h_flex().id(`cm-${col.id}-${a}`).h(24).px(8).gap(12).items_center().rounded(4).text_size(12).cursor_pointer()
            .text_color(a === "delete" ? t.blocked : t.foreground).hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { this.columnAction(a, col.id, cx); cx.notify(); })
            .child(div().flex_1().child(l)).child(this.kbd(t, key))))
      : null;
    // A click on a column's empty space or header selects it (the click then reaches the board, which takes
    // the keyboard).
    const pickCol = (_e, cx) => { if (this.sel.c !== col.index) this.sel = { c: col.index, i: 0 }; this.follow = null; this.cardMenu = null; cx.notify(); };
    return v_flex().id(`col-${col.id}`).w(COL_W).flex_none().min_h(0).on_mouse_down("left", pickCol)
      .child(header)
      .when(!!menu, (el) => el.child(menu))
      .child(v_flex().id(`cb-${col.id}`).flex_1().min_h(0).overflow_y_scroll().gap(6)
        // The column's own space: the gaps between cards, and below the last. In a gap, the spot the mouse
        // came from (the half of the card above or below) still holds; only coming in from elsewhere, or
        // below the last card, means its end.
        .on_mouse_move((e, cx) => this.track(e, this.over?.col === col.id && this.over.index != null ? this.over : { col: col.id, index: col.items.length }, cx))
        .children(cards)
        .when(col.items.length === 0 && inbox, (el) => el.child(div().px(4).text_size(11.5).text_color(t.dim).child(filtering ? "No agent matches the filter." : "Agents you start in Herdr wait here until you give them a task.")))
        // An empty column shows no selected card, so the selection is this outline instead.
        .when(col.items.length === 0 && !inbox && selCol && !draft, (el) => el.child(div().id(`empty-${col.id}`).h(40).rounded(8).border(1).border_dashed().border_color(t.accent)
          .flex().items_center().justify_center().text_size(11.5).text_color(t.dim).child(filtering ? "No match · esc clears the filter" : "Empty · n to add a task"))));
  }

  // The Archive view (A): archived and deleted tasks, newest first; restore puts one back in its column.
  archivePanel(t) {
    const list = this.archived();
    const v = this.archiveView;
    v.i = Math.max(0, Math.min(list.length - 1, v.i)); // the list shrinks as tasks are restored
    const colName = (id) => this.board.columns.find((c) => c.id === id)?.name ?? "the first column";
    const date = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const W = 640;
    return v_flex().id("archive").flex_1().min_h(0).w_full().overflow_y_scroll().p(14).gap(6).items_center()
      .child(h_flex().w(W).gap(8).items_center().pb(4)
        .child(div().text_size(13).font_semibold().child("Archive"))
        .child(div().text_size(11.5).text_color(t.dim).child("newest first · j k · r restores · deleted tasks stay 30 days"))
        .child(div().flex_1())
        .child(this.chip(t, "arch-close", "Close (esc)", false, () => { this.archiveView = null; })))
      .when(!list.length, (el) => el.child(div().w(W).text_size(12).text_color(t.dim)
        .child(this.filter ? "No archived task matches the filter." : "Nothing here yet: archived (x) and deleted (d) tasks show up here.")))
      .children(list.map((x, i) => {
        const sel = i === v.i;
        const facts = [x.deleted ? `deleted ${date(x.deleted)}` : `archived ${date(x.archived ?? x.updated ?? 0)}`, `from ${colName(x.column)}`,
          x.agents?.length ? `${x.agents.length} agent${x.agents.length > 1 ? "s" : ""}` : null, x.notes ? x.notes.split("\n")[0] : null].filter(Boolean).join(" · ");
        return h_flex().id(`arow-${i}`).w(W).px(10).py(8).gap(10).items_center().rounded(8).border(1)
          .border_color(sel ? t.accent : t.border).bg(t.surface).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { v.i = i; this.focus.focus(); cx.notify(); })
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(13).text_color(x.deleted ? t.muted : t.foreground).child(x.title))
            .child(div().truncate().text_size(11).text_color(t.dim).child(facts)))
          .child(this.kbd(t, "r", sel))
          .child(this.chip(t, `restore-${i}`, "Restore", false, (cx) => this.restore(x.id, cx)));
      }));
  }

  bottomBar(t) {
    const b = this.bar;
    if (!b && !this.attach) return null;
    const box = h_flex().id("bar").flex_none().h(36)
      // A question left open must not catch a later key (enter, y, n) meant for something else: a click
      // anywhere else answers no.
      .on_mouse_down_out((_e, cx) => { if (this.bar?.kind === "confirm" || this.bar?.kind === "move") { const no = this.bar.no; this.bar = null; no?.(cx); cx.notify(); } }).px(14).gap(10).items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(12.5).text_color(t.foreground);
    if (this.attach) return box.child(`Add "${this.attach.name}" to a task: move to it (h j k l), enter adds it`).child(div().flex_1())
      .child(this.chip(t, "attach-x", "Cancel (esc)", false, () => { this.attach = null; }));
    if (b.kind === "note") return box.child(b.text).child(div().flex_1()).child(this.chip(t, "bar-ok", "OK", false, () => { this.bar = null; }));
    if (b.kind === "help") return this.helpPanel(t);
    if (b.kind === "move") return box.child("Move to:").children((this.cols ?? []).slice(1, 10).map((c, i) => div().text_color(t.muted).child(`${i + 1} ${c.name}`)));
    return box.child(div().min_w(0).truncate().child(b.text))
      .when(!!b.never, (el) => el.child(this.chip(t, "bar-never", `${b.neverOn ? "☑" : "☐"} Don't ask again`, false, () => { b.neverOn = !b.neverOn; })))
      .child(div().flex_1())
      .child(this.chip(t, "bar-yes", "Yes (y)", true, (cx) => {
        if (b.neverOn) this.change((bd) => { bd.prefs = { ...bd.prefs, confirmDone: false }; }, cx);
        this.bar = null; b.yes(cx);
      }))
      .child(this.chip(t, "bar-no", "No (n)", false, (cx) => { this.bar = null; b.no?.(cx); }));
  }

  // The keys, grouped (?). Closed by ?, esc or any other key.
  helpPanel(t) {
    const groups = [
      ["Move", [["h l", "columns"], ["j k", "cards"], ["g G", "first, last"], ["H L", "card to next column"], ["K J", "card up, down"], ["m", "move to column…"], ["space", "to Done"]]],
      ["Tasks", [["n", "new"], ["e", "rename"], ["i", "notes"], ["x", "archive"], ["d", "delete (archived, gone in 30 days)"], ["X", "archive all of Done"], ["c", "column menu"]]],
      ["Agents", [["enter", "pick one of the task's agents"], ["1–9", "open agent (picked: its link)"], ["a", "launch an agent"], ["x", "picked: off the task"], ["e", "Inbox: make it a task"], ["t", "Inbox: add to a task"]]],
      ["Board", [["/", "filter"], ["s S", "space chips"], ["esc", "clear filter"], ["u U", "undo, redo"], ["A", "archive view"], ["?", "close"]]],
    ];
    return v_flex().id("help").flex_none().px(14).py(10).gap(8).border_t(1).border_color(t.border).bg(t.chrome).text_size(12)
      .child(h_flex().gap(8).items_center().child(div().font_semibold().child("Keys")).child(div().text_color(t.dim).text_size(10.5).child(BUILD)))
      .child(h_flex().gap(28).items_start().children(groups.map(([name, rows]) => v_flex().gap(3)
        .child(div().text_size(10.5).text_color(t.dim).child(name))
        .children(rows.map(([k, l]) => h_flex().gap(8).child(div().w(44).flex_none().text_color(t.accent).child(k)).child(div().text_color(t.muted).child(l)))))));
  }

  // "Next up": Claude agents waiting for you (not working) whose cache is still warm, soonest to expire
  // first, so the one to answer before its cache goes cold is leftmost. Null when there are none.
  nextUp(t, now) {
    const waiting = [...this.ags.values()]
      .filter((a) => a.status !== "working")
      .map((a) => ({ a, w: warmth(this.cache.info(this.terms.get(a.address)), now) }))
      .filter((x) => x.w && !x.w.cold)
      .sort((x, y) => this.cache.info(this.terms.get(x.a.address)).expires - this.cache.info(this.terms.get(y.a.address)).expires);
    if (!waiting.length) return null;
    const taskOf = (addr) => this.task(this.terms.get(addr)?.labels?.["corral.task"])?.title;
    return h_flex().id("nextup").flex_none().h(34).px(14).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).overflow_hidden()
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Next up"))
      .children(waiting.map(({ a }) => {
        const term = this.terms.get(a.address);
        const sp = src.spaces().find((x) => x.id === a.space);
        const label = taskOf(a.address) ?? agentName(a);
        return h_flex().id(`nu-${a.address}`).flex_none().h(24).px(7).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(alpha(t.foreground, "0a")).hover((el) => el.bg(t.hover))
          .tooltip(`${agentName(a)} · ${a.space_name ?? ""}`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.goTo(a); })
          .child(spaceTile(t, sp, 13))
          .child(div().max_w(180).truncate().text_size(12).text_color(t.foreground).child(label))
          .child(this.status(t, a.status, this.cache.info(term)?.waitingFor) ?? div())
          .child(this.cacheBadge(t, term, now) ?? div());
      }));
  }

  pill(t) {
    const showing = find(layout(), "corral-view")?.active === "board";
    // Agents waiting for you (needs you, or done and not looked at), as a badge in the needs-you color.
    // Sub-agents don't count: the board doesn't show them, and their parent asks for you.
    const sub = new Set(src.terminals().filter((x) => x.parent).map((x) => x.address));
    const needs = src.agents().filter((a) => (a.status === "blocked" || a.status === "done") && !sub.has(a.address)).length;
    // A button at the top bar's right end, drawn like the tabs bar's Files and Changes (which it sits beside):
    // the bar's own background and bottom border around it.
    return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("pill").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
        .bg(showing ? t.selected : t.chrome).text_color(showing ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .tooltip("cmd-shift-k")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { flip(); askFocusSoon(cx); cx.notify(); })
        .child(svg(`${ICONS}/layers.svg`).size(14))
        .child(showing ? "Terminals" : "Board")
        .when(needs > 0, (el) => el.child(div().px(5).h(16).rounded(4).flex().items_center().bg(alpha(t.blocked, "33")).text_color(t.blocked)
          .text_size(10.5).font_semibold().id("needs").tooltip(`${needs} waiting for you`).child(String(needs)))));
  }

  render(cx) {
    const t = theme();
    if (this.role === "pill") return this.pill(t);
    const now = Date.now();
    this.terms = new Map(src.terminals().map((x) => [x.address, x]));
    this.ags = new Map(src.agents().map((a) => [a.address, a]));
    const cols = this.shown(this.terms, this.ags).map((c, index) => ({ ...c, index }));
    this.cols = cols;
    // A task moved by key stays selected once it shows up in its new column.
    if (this.follow) {
      const i = cols[this.follow.c]?.items.findIndex((x) => x.kind === "task" && x.task.id === this.follow.id) ?? -1;
      if (i >= 0) { this.sel = { c: this.follow.c, i }; this.follow = null; }
      // Saved in that column but not shown (a filter hides it): stop following, or keys would act on a task
      // you can't see instead of the card that looks selected.
      else { const tk = this.task(this.follow.id); if (tk && tk.column === cols[this.follow.c]?.id) this.follow = null; }
    }
    // The selection stays on a card or column that exists (cards go when archived, filtered, or an agent ends).
    if (!this.follow && cols.length) {
      this.sel.c = Math.max(0, Math.min(cols.length - 1, this.sel.c));
      this.sel.i = Math.max(0, Math.min(Math.max(0, cols[this.sel.c].items.length - 1), this.sel.i));
    }
    // The launch form belongs to the selected card: it closes when the selection leaves it or the task goes.
    if (this.open && !this.follow && (!this.task(this.open) || cols[this.sel.c]?.items[this.sel.i]?.id !== this.open)) { this.open = null; this.launch = null; }
    // A text box whose task went away (archived elsewhere, an older backup restored) closes.
    if (this.notesEdit && !this.task(this.notesEdit.id)) { this.notesEdit.done = true; this.notesEdit = null; this.wakeFocus?.(); }
    if (this.rename?.kind === "task" && !this.task(this.rename.id)) { this.rename.done = true; this.rename = null; this.wakeFocus?.(); }
    // A text box that held the keyboard and is gone now (its card closed, say): the board takes the keyboard.
    if (this.inputs.size) {
      const live = this.liveInputs();
      const gone = [...this.inputs].filter((x) => !live.has(x));
      if (gone.length) { for (const x of gone) this.inputs.delete(x); if (!this.inputs.size) this.wakeFocus?.(); }
    }
    const inOverlay = !!props()?.overlay;
    // Focus can't move during render: do it from a task, right after. Asked for by flip() through shared state,
    // because a hidden copy doesn't render and can't notice it became visible.
    const ask = shared("corral.focusAt") ?? 0;
    // Only once actually shown (the request can arrive while the stack still shows the terminals), and again
    // shortly after, in case the app hands the keyboard back to the terminal pane after the switch.
    // Once per request, plus once when first shown as a popup (nothing asks there): grabbing it on every
    // render would pull the keyboard out of a text box the moment it opens (issue #1).
    const shown = inOverlay || find(layout(), "corral-view")?.active === "board";
    // A popup takes it once when it opens and ignores flips (they are another copy's, maybe in another window).
    if (shown && ((!inOverlay && ask && ask !== this.focusedAt) || (inOverlay && !this.overlayFocused))) {
      this.focusedAt = ask;
      this.overlayFocused = inOverlay;
      this.wakeFocus?.();
    }
    const ghost = this.drag && this.press && this.mouse && this.origin
      ? div().absolute().left(this.mouse.x - this.origin.x - this.press.dx).top(this.mouse.y - this.origin.y - this.press.dy).w(COL_W - 8)
        .p(10).rounded(8).border(1).border_color(t.accent).bg(t.surface).opacity(0.9).text_size(13).text_color(t.foreground).child(this.press.title)
      : null;
    const s = this.store;
    return v_flex().id("root").size_full().relative().bg(t.canvas).text_color(t.foreground)
      .track_focus(this.focus)
      .key_context("CorralBoard")
      // Bindings dev.19-22 installed live until Herdr restarts: answer them instead of failing.
      .on_action("corral_commit", (_e, cx) => this.commit(cx))
      .on_action("corral_newline", (_e, cx) => { (this.notesEdit?.state ?? (this.open && this.launch?.msg))?.replace?.("\n"); cx.notify(); })
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.focus.focus(); this.colMenu = null; this.cardMenu = null; cx.notify(); })
      .on_mouse_move((e, cx) => {
        this.origin = { x: e.bounds.x, y: e.bounds.y };
        this.mouse = e.position;
        if (this.drag) { this.over = null; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag) { this.drop(cx); this.dragEnd = Date.now(); }
        this.press = null; this.drag = null; this.over = null;
        cx.notify();
      })
      .on_hover((h, cx) => { if (!h && this.press) { this.press = this.drag = this.over = null; cx.notify(); } })
      .child(h_flex().id("hdr").h(40).px(14).gap(10).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Corral"))
        .child(div().text_size(10.5).text_color(t.dim).child(BUILD))
        // Lit while the board has the keyboard (its keys work); dim when they'd go elsewhere.
        .child(div().id("kbd").text_size(10.5).text_color(this.focus.is_focused() || this.typing ? t.accent : alpha(t.dim, "66"))
          .tooltip(this.focus.is_focused() || this.typing ? "Keys go to the board" : "Click the board to use its keys").child("⌨"))
        .child(div().w(180).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.filterState).h(26).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_size(12)))
        .child(div().flex_1())
        .child(this.kbd(t, "u"))
        .child(this.chip(t, "undo", "↶ Undo", false, (cx) => this.undo(cx)))
        .child(this.kbd(t, "U"))
        .child(this.chip(t, "redo", "↷ Redo", false, (cx) => this.undo(cx, true)))
        .child(this.kbd(t, "A"))
        .child(this.chip(t, "archive", "Archive", !!this.archiveView, () => { this.archiveView = this.archiveView ? null : { i: 0 }; this.focus.focus(); }))
        .child(this.chip(t, "new-task", "+ Task", false, (cx) => this.addTask(this.board.columns[0]?.id, cx)))
        .child(this.chip(t, "keys", "?", this.bar?.kind === "help", () => { this.bar = this.bar?.kind === "help" ? null : { kind: "help" }; }))
        .child(inOverlay
          ? this.chip(t, "close", "Close", false, () => closeOverlay(props().overlay))
          : find(layout(), "corral-view") ? this.chip(t, "back", "← Terminals", false, () => flip("main")) : div()))
      .when(!!this.nextUp(t, now), (el) => el.child(this.nextUp(t, now)))
      .when(!this.archiveView && !!this.spaceChips(t), (el) => el.child(this.spaceChips(t)))
      .when(!!s.error || s.readOnly, (el) => el.child(div().px(14).py(6).bg(alpha(t.blocked, "22")).text_size(12).text_color(t.blocked)
        .child(s.error ?? "This board was made by a newer Corral Board; it is shown read-only.")))
      // Sideways scrolling is ours: only a swipe's horizontal part (or shift + wheel) moves the board,
      // so a vertical swipe that reaches a column's end never turns into a sideways scroll.
      .when(!!this.archiveView, (el) => el.child(this.archivePanel(t)))
      .when(!this.archiveView, (el) => el.child(div().id("cols-view").flex_1().min_h(0).w_full().relative().overflow_hidden()
        .on_size_change((size, cx) => { this.viewW = size.width; cx.notify(); })
        .on_scroll_wheel((e, cx) => {
          const dx = e.modifiers?.shift && !e.delta.x ? e.delta.y : e.delta.x;
          if (!dx) return;
          const max = Math.max(0, cols.length * (COL_W + 10) + 10 - (this.viewW ?? 0));
          const next = Math.max(0, Math.min(max, (this.scrollX ?? 0) - dx));
          if (next !== this.scrollX) { this.scrollX = next; cx.notify(); }
        })
        .child(h_flex().id("cols").absolute().top(0).bottom(0).left(-(this.scrollX ?? 0)).p(10).gap(10).items_stretch()
          .children(cols.map((c) => this.column(t, c, now))))))
      .when(!!this.bottomBar(t), (el) => el.child(this.bottomBar(t)))
      .when(!!ghost, (el) => el.child(ghost));
  }
}
