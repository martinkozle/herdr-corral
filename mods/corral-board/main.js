// Corral Board: your tasks in your columns, each holding the agents you started for it.
// See RECIPE.md. Props: none → the board; { role: "pill" } → the corral layout's toggle.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, terminals, spaces, machines, theme, run, exec, hc, props, layout, closeOverlay, nextCommand, knownAgents, watchFolder, focused, shared, setShared } from "herdr";
import { Store, newId, DIR } from "./store.js";
import { Cache, warmth, warmthColor } from "./cache.js";

const ICONS = "mods/workspace-chrome";
const COL_W = 280;
const INBOX = "inbox";
const CUSTOM = "__custom";
// In notes and the first message, Enter saves / launches and Shift+Enter is a new line, as in Claude Code.
// Bump on every change: shown in the header and the ? bar, to see which build is running.
const BUILD = "0.1.1-dev.2";

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
  const color = shared("space.colors")?.[space.id] ?? "ansi6";
  const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
  return h_flex().size(size).flex_none().rounded(size * 0.28).bg(fill).items_center().justify_center()
    .text_size(size * 0.6).font_bold().text_color("#ffffff").child([...space.name][0]?.toUpperCase() ?? "?");
}

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);

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

export default class Board extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "board";
    if (this.role === "pill") {
      cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "toggle") { flip(); askFocusSoon(cx); } cx.notify(); } });
      return;
    }
    this.store = new Store();
    this.cache = new Cache();
    this.focus = cx.focus_handle();
    this.sel = { c: 1, i: 0 };
    this.open = null;      // the opened task's id
    this.typing = 0;       // inputs holding the keyboard: board keys stay off
    this.press = null;     // a press that may become a drag
    this.drag = null;
    this.over = null;      // where a drag would land: { col, index } or { task }
    this.bar = null;       // the bottom prompt: confirm, move picker or help
    this.known = {};       // knownAgents per machine
    this.launch = null;    // the open card's launch form
    this.colMenu = null;
    this.rename = null;    // { kind: "task" | "column" | "inbox", id, state }
    // No cx.bind_keys: its bindings are app-wide and outlive a reload (a removed one fails as an unknown
    // command until Herdr restarts). Enter variants arrive as the textarea's "submit" event instead.
    this.filterState = this.input("Filter tasks", "", (s) => { this.filter = s.value().toLowerCase(); });
    this.filter = "";
    cx.spawn(async (cx) => {
      await this.store.load();
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
        for (const ms of [0, 60, 200]) { if (ms) await cx.sleep(ms); this.focus.focus(); }
        cx.notify();
      }
    });
    const tick = (cx) => cx.spawn(async (cx) => {
      await this.cache.refresh(terminals(), cx, () => {});
      await this.adopt();
      await this.recordSessions();
      cx.notify();
    });
    tick(cx);
    cx.timer.every(30000, tick);
  }

  // An InputState that keeps board keys off while it has the keyboard.
  input(placeholder, value, onChange, multi = false) {
    const s = multi ? TextareaState.new({ placeholder, value }) : InputState.new({ placeholder, value });
    s.on("focus", (_e, cx) => { this.typing++; cx.notify(); });
    s.on("blur", (_e, cx) => { this.typing = Math.max(0, this.typing - 1); cx.notify(); });
    if (onChange) s.on("change", (_e, cx) => { onChange(s); cx.notify(); });
    return s;
  }

  get board() { return this.store.board; }
  task(id) { return this.board.tasks.find((t) => t.id === id); }
  change(fn, cx) { cx.spawn(async (cx) => { await this.store.change(fn); cx.notify(); }); }

  // Live terminals labelled for a task rejoin it, even if the file lost them.
  async adopt() {
    const missing = [];
    for (const t of terminals()) {
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
        task?.agents.push({ address: t.address, app: t.report?.app ?? null, name: t.title || t.program?.name || task.title, space: t.labels?.["herdr.space"] ?? null, started: t.created_ms ?? Date.now() });
      }
    });
  }

  // Remembers each live Claude agent's session and folder on its row: what `claude --resume` needs later.
  async recordSessions() {
    const terms = new Map(terminals().map((x) => [x.address, x]));
    const ups = [];
    for (const t of this.board.tasks) for (const r of t.agents) {
      const term = terms.get(r.address);
      if (term?.labels?.["corral.task"] !== t.id) continue;
      const info = this.cache.info(term);
      // Resumable only once the conversation is on disk: Claude writes it with the first message, and
      // `claude --resume` refuses a session that has none.
      if (info?.sid && info.path && (r.session !== info.sid || r.cwd !== info.cwd)) ups.push([t.id, r.address, info.sid, info.cwd]);
    }
    if (!ups.length) return;
    await this.store.change((b) => {
      for (const [tid, addr, sid, cwd] of ups) {
        const r = b.tasks.find((x) => x.id === tid)?.agents.find((x) => x.address === addr);
        if (r) { r.session = sid; r.cwd = cwd; r.app = "claude-code"; }
      }
    });
  }

  // Starts an ended Claude agent again with its conversation: `claude --resume <session>` in its folder.
  async revive(taskId, row, cx) {
    const task = this.task(taskId);
    // The conversation lives on the machine the agent ran on: resume there, never on another machine.
    const m = machineOf(row.address);
    const here = spaces().filter((s) => (s.machine ?? null) === m);
    const space = here.find((s) => s.id === (row.space ?? task?.space)) ?? here.find((s) => s.active) ?? here[0];
    if (!task || !row.session) return;
    if (!space) { this.bar = { kind: "note", text: `Couldn't resume: no space open on ${m ?? "this computer"}` }; cx.notify(); return; }
    try {
      const args = { space: space.id, name: row.name, argv: ["claude", "--resume", row.session] };
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

  // One agent row's live facts: "live" with its agent, "ended", or "unknown" (its machine is away).
  rowState(task, row, terms, ags) {
    const term = terms.get(row.address);
    const m = machineOf(row.address);
    if (!term) {
      const away = m && machines().find((x) => x.name === m)?.layout !== "ready";
      return { state: away ? "unknown" : "ended" };
    }
    if (term.state !== "live" || term.labels?.["corral.task"] !== task.id) return { state: "ended" };
    const a = ags.get(row.address);
    return a ? { state: "live", agent: a, term } : { state: "ended" };
  }

  // Columns as shown: Inbox first (agents in no task), then the board's, filtered.
  shown(terms, ags) {
    const claimed = new Set();
    for (const t of this.board.tasks) for (const r of t.agents) if (this.rowState(t, r, terms, ags).state !== "ended") claimed.add(r.address);
    const inbox = [...ags.values()].filter((a) => !claimed.has(a.address) && !terms.get(a.address)?.parent);
    const f = this.filter;
    const match = (t) => !f || `${t.title}\n${t.notes ?? ""}\n${t.agents.map((a) => a.name).join("\n")}`.toLowerCase().includes(f);
    return [
      { id: INBOX, name: "Inbox", items: inbox.filter((a) => !f || agentName(a).toLowerCase().includes(f)).map((a) => ({ kind: "inbox", id: a.address, agent: a })) },
      ...this.board.columns.map((c) => ({ id: c.id, name: c.name, items: this.board.tasks.filter((t) => t.column === c.id && match(t)).map((t) => ({ kind: "task", id: t.id, task: t })) })),
    ];
  }

  // ---- changes ----

  doneColumn() { return this.board.columns.find((c) => c.id === "done") ?? this.board.columns.at(-1); }

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
  label(address, taskId) { hc(["label", address, `corral.task=${taskId ?? ""}`]).catch(() => {}); }

  drop(cx) {
    const { press, over } = this;
    if (!press || !over) return;
    if (press.kind === "task") {
      if (over.col && over.col !== INBOX) this.change((b) => this.place(b, press.id, over.col, over.index), cx);
      return;
    }
    // An agent: from the Inbox, or a row of a task (press.from).
    const a = agents().find((x) => x.address === press.id);
    const from = press.from ?? null;
    const unhook = (b) => { const s = from && b.tasks.find((t) => t.id === from); if (s) s.agents = s.agents.filter((r) => r.address !== press.id); };
    if (over.task) {
      if (over.task === from || !a) return;
      this.label(press.id, over.task);
      this.change((b) => { unhook(b); b.tasks.find((t) => t.id === over.task)?.agents.push(this.rowFrom(a)); }, cx);
    } else if (over.col === INBOX) {
      if (!from) return;
      this.label(press.id, null);
      this.change(unhook, cx);
    } else if (over.col && a) {
      const id = newId("t");
      this.label(a.address, id);
      this.change((b) => { unhook(b); this.newTask(b, over.col, agentName(a), a).id = id; this.place(b, id, over.col, over.index); }, cx);
    }
  }

  async doLaunch(task, cx) {
    const L = this.launch;
    const space = spaces().find((s) => s.id === L.space);
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
      const r = await exec("herdr-app", ["do", "tab.new", JSON.stringify(args)]);
      const out = JSON.parse(r.stdout || "{}");
      if (r.code !== 0 || !out.terminal) throw new Error(out.error ?? (r.stderr || "no terminal"));
      await hc(["label", out.terminal, `corral.task=${task.id}`]);
      await this.store.change((b) => {
        const t = b.tasks.find((x) => x.id === task.id);
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

  // mode: "info" (notes, rename, archive, delete) or "launch" (start an agent for it). Again: closes.
  openTask(task, cx, mode = "info") {
    if (!task || (this.open === task.id && this.openMode === mode)) { this.open = null; this.launch = null; return; }
    this.open = task.id;
    this.openMode = mode;
    this.launch = null;
    if (mode === "info") {
      this.notes = this.input("Notes", task.notes ?? "", null, true);
      this.notes.set_auto_grow(2, 10);
      this.notes.on("blur", (_e, cx) => { const v = this.notes.value(); if (v !== (this.task(task.id)?.notes ?? "")) this.change((b) => { b.tasks.find((t) => t.id === task.id).notes = v; }, cx); });
      return;
    }
    const space = task.space ?? spaces().find((s) => s.active)?.id ?? spaces()[0]?.id;
    this.launch = {
      space, agent: null, busy: false, error: null,
      msg: this.input("First message (optional)", "", null, true),
      custom: this.input("Command, e.g. pi --model x", this.board.prefs?.customCommand ?? "", null),
    };
    this.launch.msg.set_auto_grow(2, 6);
    this.launch.msg.on("submit", (e, cx) => this.submitted(this.launch.msg, e, () => this.commit(cx), cx));
    this.launch.msg.focus();
    this.loadAgents(space, cx);
  }

  loadAgents(spaceId, cx) {
    const m = spaces().find((s) => s.id === spaceId)?.machine ?? "";
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

  startRename(kind, id, value) {
    const s = this.input("Name", value, null);
    s.on("submit", (_e, cx) => this.finishRename(cx));
    s.on("blur", (_e, cx) => this.finishRename(cx));
    this.rename = { kind, id, state: s };
    s.focus();
  }

  finishRename(cx) {
    const r = this.rename;
    if (!r) return;
    this.rename = null;
    const v = r.state.value().trim();
    this.focus.focus();
    if (!v) { cx.notify(); return; }
    if (r.kind === "new") this.change((b) => { this.newTask(b, r.id, v); }, cx);
    if (r.kind === "task") this.change((b) => { b.tasks.find((t) => t.id === r.id).title = v; }, cx);
    if (r.kind === "column") this.change((b) => { b.columns.find((c) => c.id === r.id).name = v; }, cx);
    if (r.kind === "inbox") {
      const a = agents().find((x) => x.address === r.id);
      if (!a) return;
      const id = newId("t");
      this.label(a.address, id);
      this.change((b) => { this.newTask(b, b.columns[0].id, v, a).id = id; }, cx);
    }
    cx.notify();
  }

  // A draft card at the top of the column: Enter or leaving the field with text creates it, Esc cancels.
  addTask(col, _cx) {
    if (col) this.startRename("new", col, "");
  }

  ask(text, yes, extra) { this.bar = { kind: "confirm", text, yes, ...extra }; }

  columnAction(action, col, cx) {
    this.colMenu = null;
    const b = this.board;
    const i = b.columns.findIndex((c) => c.id === col);
    if (action === "rename") return this.startRename("column", col, b.columns[i].name);
    if (action === "delete") {
      if (b.tasks.some((t) => t.column === col)) { this.bar = { kind: "note", text: "Move its tasks first." }; return; }
      return this.change((b) => { b.columns.splice(i, 1); }, cx);
    }
    if (action === "left" || action === "right") {
      const j = action === "left" ? i - 1 : i + 1;
      if (j < 0 || j >= b.columns.length) return;
      return this.change((b) => { const [c] = b.columns.splice(i, 1); b.columns.splice(j, 0, c); }, cx);
    }
    if (action === "add" || action === "before") {
      const id = newId("c");
      this.change((b) => { b.columns.splice(action === "add" ? i + 1 : i, 0, { id, name: "New column" }); }, cx);
      this.startRename("column", id, "");
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
            no: () => { ed.asking = false; ed.state.focus(); },
          });
        } else { this.rename = null; this.focus.focus(); }
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
      if (k === "y" || k === "enter") { this.bar.yes(cx); this.bar = null; }
      else if (k === "n" || k === "escape") { const no = this.bar.no; this.bar = null; no?.(cx); }
      cx.notify(); return;
    }
    if (this.bar?.kind === "move") {
      const n = parseInt(k, 10);
      if (n >= 1 && n < cols.length) sendTo(n);
      this.bar = null; cx.notify(); return;
    }
    // Picking one of the selected task's agents (enter): j k move, enter opens it, anything else leaves.
    if (this.pickAgent != null && task) {
      const rows = this.shownRows(task);
      const x = rows[this.pickAgent];
      if (k === "j" || k === "down") { this.pickAgent = Math.min(rows.length - 1, this.pickAgent + 1); cx.notify(); return; }
      if (k === "k" || k === "up") { this.pickAgent = Math.max(0, this.pickAgent - 1); cx.notify(); return; }
      if (k === "enter") { this.pickAgent = null; this.actOnRow(task, x, cx); cx.notify(); return; }
      // d or x: this agent leaves the task (back to the Inbox; its terminal keeps running). Never the task.
      if ((k === "x" || k === "d") && x) {
        this.label(x.r.address, null); // whatever runs there now (an agent, or the shell it left)
        this.change((b) => { const tk = b.tasks.find((t) => t.id === task.id); tk.agents = tk.agents.filter((r) => r.address !== x.r.address); }, cx);
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
    if (["h", "l", "j", "k", "g", "G", "shift-g", "left", "right", "up", "down"].includes(k)) this.follow = null;
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
        if (task && !pending && this.sel.i > 0) { this.change((b) => this.place(b, task.id, col.id, this.sel.i - 1), cx); this.sel.i--; } break;
      case "J": case "shift-j": case "shift-down":
        if (task && !pending && this.sel.i < col.items.length - 1) { this.change((b) => this.place(b, task.id, col.id, this.sel.i + 1), cx); this.sel.i++; } break;
      case "m": if (task || item?.kind === "inbox") this.bar = { kind: "move" }; break;
      case "space": {
        if (!task) break;
        const done = this.doneColumn();
        const go = (cx) => this.change((b) => this.place(b, task.id, done.id, Infinity), cx);
        if (this.board.prefs?.confirmDone === false) go(cx);
        else this.ask(`Move "${task.title}" to ${done.name}?`, go, { never: true });
        break;
      }
      case "n": if (col && col.id !== INBOX) this.addTask(col.id, cx); break;
      case "e":
        if (task) this.startRename("task", task.id, task.title);
        else if (item?.kind === "inbox") this.startRename("inbox", item.id, agentName(item.agent));
        break;
      case "enter":
        if (task && task.agents.length) this.pickAgent = 0;
        else if (item?.kind === "inbox") this.goTo(item.agent);
        break;
      case "escape": this.open = null; this.launch = null; this.filterState.set_value(""); this.filter = ""; break;
      case "a": if (task) this.openTask(task, cx, "launch"); break;
      case "i": if (task) this.startNotes(task); break;
      case "x": if (task) this.change((b) => { b.tasks = b.tasks.filter((t) => t.id !== task.id); b.archive.push({ ...task, archived: Date.now() }); }, cx); break;
      case "d": if (task) this.ask(`Delete "${task.title}"?`, (cx) => this.change((b) => { b.tasks = b.tasks.filter((t) => t.id !== task.id); }, cx)); break;
      case "X": case "shift-x": this.ask(`Archive every task in ${this.doneColumn().name}?`, (cx) => this.clearDone(cx)); break;
      case "/": this.filterState.focus(); break;
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
    const done = this.doneColumn().id;
    this.change((b) => {
      const now = Date.now();
      b.archive.push(...b.tasks.filter((t) => t.column === done).map((t) => ({ ...t, archived: now })));
      b.tasks = b.tasks.filter((t) => t.column !== done);
    }, cx);
  }

  // ---- drawing ----

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
    return div().flex_none().px(5).h(16).rounded(4).bg(alpha(c, "33")).text_color(c).text_size(10.5).font_semibold().flex().items_center().child(w.text);
  }

  agentRow(t, row, st, now, hovered, taskId, picked, num, showX, hints) {
    const live = st.state === "live";
    const resumable = st.state === "ended" && !!row.session;
    const a = st.agent;
    const sp = spaces().find((s) => s.id === (a?.space ?? row.space));
    const pic = icon(a?.program, 14, t.foreground);
    // Each agent is its own faint block (live ones tinted), so neighbours read apart without inner borders.
    return h_flex().id(`ar-${row.address}`).gap(6).px(4).py(4).rounded(6).items_start().text_size(12)
      .when(st.state !== "ended" && !picked, (el) => el.bg(alpha(t.foreground, "0a")))
      .when(picked, (el) => el.bg(t.selected))
      .when(live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        // A row can be dragged to another task, a column (a new task) or the Inbox (out of its task).
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.focus.focus();
          this.press = { kind: "agent", from: taskId, id: row.address, x: e.position.x, y: e.position.y, dx: e.local_position?.x ?? 0, dy: e.local_position?.y ?? 0, title: agentName(a) };
          cx.notify();
        })
        .on_click((_e, cx) => { cx.stop_propagation(); if (!this.wasDrag()) this.goTo(a); }))
      // An ended Claude agent: dashed, and a click resumes its conversation in a new tab.
      .when(resumable, (el) => el.border(1).border_dashed().border_color(t.input).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip("Resume this conversation (claude --resume)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (!this.wasDrag()) cx.spawn((cx) => this.revive(taskId, row, cx)); }))
      .child(div().pt(1).w(8).flex_none().child(this.kbd(t, num, hints)))
      .child(div().pt(1).w(14).flex_none().when(!!pic, (el) => el.child(pic)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_color(live ? t.foreground : t.dim).child(live ? agentName(a) : (row.name || this.task(taskId)?.title || row.address)))
        .child(h_flex().gap(5).items_center().min_w(0)
          .when(!!sp, (el) => el.child(spaceTile(t, sp, 13)))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(sp?.name ?? ""))))
      // Status on top, cache time under it, right-aligned together.
      .child(v_flex().flex_none().gap(2).items_end()
        .child(h_flex().h(16).items_center()
          .when(live, (el) => el.child(this.status(t, a.status, this.cache.info(st.term)?.waitingFor) ?? div()))
          .when(st.state === "unknown", (el) => el.child(div().text_size(10.5).text_color(t.dim).child("away")))
          .when(st.state === "ended", (el) => el.child(div().text_size(10.5).text_color(resumable ? t.muted : t.dim).child(resumable ? "↻ resume" : "ended"))))
        .when(live, (el) => el.child(this.cacheBadge(t, st.term, now) ?? div())))
      .child(h_flex().h(16).flex_none().gap(3).items_center()
        .child(this.kbd(t, "x", showX))
        // Always there (keeps the row's width); visible on hover or while this row is picked.
        .child(div().id(`rm-${row.address}`).px(2).text_color(t.dim).when(!(hovered || showX), (el) => el.opacity(0)).hover((s) => s.text_color(t.foreground)).tooltip("Back to the Inbox")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.label(row.address, null); this.change((b) => { const tk = b.tasks.find((x) => x.id === taskId); tk.agents = tk.agents.filter((r) => r.address !== row.address); }, cx); })
          .child("×")));
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
    else if (x.st.state === "ended" && x.r.session) cx.spawn((cx) => this.revive(task.id, x.r, cx));
  }

  startNotes(task) {
    const s = this.input("Notes", task.notes ?? "", null, true);
    s.set_auto_grow(2, 12);
    s.on("blur", (_e, cx) => this.saveNotes(cx));
    s.on("submit", (e, cx) => this.submitted(s, e, () => this.saveNotes(cx), cx));
    this.notesEdit = { id: task.id, state: s, before: task.notes ?? "" };
    s.focus();
    // The cursor goes after the text, where you'd continue typing.
    const end = (task.notes ?? "").length;
    s.set_selected_range({ start: end, end });
  }

  // Saves the open notes editor (Save, or clicking away). Esc clears notesEdit first, so nothing is saved.
  saveNotes(cx) {
    const ed = this.notesEdit;
    if (!ed || ed.asking) return;
    this.notesEdit = null;
    const v = ed.state.value().trim();
    if (v !== (this.task(ed.id)?.notes ?? "")) this.change((b) => { b.tasks.find((t) => t.id === ed.id).notes = v; }, cx);
    this.focus.focus();
    cx.notify();
  }

  // Cancel: back to the notes as they were. Clicking the button may already have saved (the field lost
  // the keyboard first), so this restores rather than just discards.
  cancelNotes(id, before, cx) {
    this.notesEdit = null;
    if ((this.task(id)?.notes ?? "") !== before) this.change((b) => { b.tasks.find((t) => t.id === id).notes = before; }, cx);
    this.focus.focus();
  }

  // A key hint: a faint letter beside its control, not a box (a box reads as a key to press with it).
  // Hover and selection never change layout, only visibility: a hidden hint keeps its space.
  kbd(t, key, show = true) {
    return div().flex_none().text_size(10).text_color(alpha(t.dim, "b0")).when(!show, (el) => el.opacity(0)).child(key);
  }

  card(t, col, item, i, now) {
    const selected = this.sel.c === col.index && this.sel.i === i;
    const lifted = this.drag && this.press?.id === item.id;
    const hovered = this.hoverCard === item.id;
    const base = v_flex().id(`card-${item.id}`).w_full().p(10).gap(6).rounded(8).border(1).bg(t.surface)
      .border_color(selected ? t.accent : t.border)
      .when(lifted, (el) => el.opacity(0.35))
      .on_hover((h, cx) => { if (h) this.hoverCard = item.id; else if (this.hoverCard === item.id) this.hoverCard = null; cx.notify(); })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.focus.focus();
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
      return base.border_color(selected ? t.accent : t.input).bg(t.background)
        .child(this.rename?.kind === "inbox" && this.rename.id === a.address ? this.field(t, this.rename.state) : div().text_size(13).text_color(t.foreground).child(agentName(a)))
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
          .when(!!icon(a.program, 13, t.foreground), (el) => el.child(icon(a.program, 13, t.foreground)))
          .child(spaceTile(t, spaces().find((s) => s.id === a.space), 13))
          .child(div().flex_1().truncate().child(a.space_name ?? ""))
          .child(this.cacheBadge(t, term, now) ?? div())
          .child(this.status(t, a.status, this.cache.info(term)?.waitingFor) ?? div()));
    }
    const task = item.task;
    const launching = this.open === task.id;
    const hints = selected || hovered;
    const shownRows = this.shownRows(task);
    const picked = selected && this.pickAgent != null ? shownRows[this.pickAgent]?.r.address : null;
    const pencil = (id, tip, click, key) => this.iconButton(t, id, "square-pen", tip, click, key, hints).when(!hints, (el) => el.opacity(0));
    const menuOpen = this.cardMenu === task.id;
    return base.when(attachHere, (el) => el.border_color(t.accent).bg(t.selected))
      .child(this.rename?.kind === "task" && this.rename.id === task.id
        ? this.field(t, this.rename.state)
        : h_flex().gap(2).items_start()
          .child(div().id(`title-${task.id}`).flex_1().min_w(0).pr(4).text_size(13).font_medium().text_color(t.foreground)
            .on_click((e, cx) => { if (e.click_count >= 2 && !this.wasDrag()) { this.startRename("task", task.id, task.title); cx.notify(); } })
            .child(task.title))
          .child(pencil(`ren-${task.id}`, "Rename (e)", () => this.startRename("task", task.id, task.title), "e"))
          .child(this.iconButton(t, `launch-${task.id}`, "plus", "Launch an agent (a)", (cx) => this.openTask(task, cx, "launch"), "a", hints))
          .child(div().id(`cmenu-${task.id}`).px(5).rounded(4).text_size(13).text_color(menuOpen ? t.foreground : t.dim).cursor_pointer().tooltip("More")
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.cardMenu = menuOpen ? null : task.id; cx.notify(); }).child("⋯")))
      .when(menuOpen, (el) => el.child(this.menu(t, `cm-${task.id}`, [
        ["Archive  (x)", (cx) => this.change((b) => { b.tasks = b.tasks.filter((x) => x.id !== task.id); b.archive.push({ ...task, archived: Date.now() }); }, cx)],
        ["Delete  (d)", () => this.ask(`Delete "${task.title}"?`, (cx) => this.change((b) => { b.tasks = b.tasks.filter((x) => x.id !== task.id); }, cx)), true],
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
          .on_click((_e, cx) => { cx.stop_propagation(); this.startNotes(task); cx.notify(); })
          .child(h_flex().gap(6).items_start()
            .child(div().flex_1().min_w(0).child(task.notes || "Add notes…"))
            .child(this.kbd(t, "i", hints))))
      .when(shownRows.length > 0, (el) => el.child(v_flex().gap(4).children(shownRows.map((x, n) => this.agentRow(t, x.r, x.st, now, hovered, task.id, x.r.address === picked, n < 9 ? String(n + 1) : "", picked === x.r.address, hints)))))
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
    return div().id(id).px(7).h(22).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
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
    const row = (o) => div().id(`${id}-${o.key}`).h(24).px(8).flex().items_center().rounded(4).text_size(12).truncate().cursor_pointer()
      .text_color(o.key === value?.key ? t.foreground : t.muted).when(o.key === value?.key, (el) => el.bg(t.selected))
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
      .when(open, (el) => el.child(v_flex().id(`${id}-list`).max_h(180).overflow_y_scroll().p(3).rounded(6).border(1).border_color(t.border).bg(t.popover).children(options.map(row))));
  }

  details(t, task) {
    const L = this.launch;
    const sp = spaces().find((s) => s.id === L?.space);
    const spaceOpts = spaces().map((s) => ({ key: s.id, label: s.machine ? `${s.machine} · ${s.name}` : s.name }));
    const agentOpts = [...(this.known[sp?.machine ?? ""] ?? []).filter((k) => k.installed).map((k) => ({ key: k.key, label: k.name })), { key: CUSTOM, label: "Custom command…" }];
    const info = this.openMode === "info";
    const label = (s) => div().text_size(11).text_color(t.dim).child(s);
    const box = (state) => Textarea.new(state).px(8).py(6).rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12.5);
    const link = (id, text, click) => div().id(id).text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); cx.notify(); }).child(text);
    return v_flex().id(`det-${task.id}`).gap(6).pt(8).border_t(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(info, (el) => el.child(label("Notes")).child(box(this.notes)))
      .when(!!L, (el) => el
        .child(label("Launch an agent"))
        .child(h_flex().gap(6).items_start()
          .child(this.picker(t, `psp-${task.id}`, spaceOpts.find((o) => o.key === L.space), spaceOpts, (o, cx) => { L.space = o.key; L.agent = null; this.loadAgents(o.key, cx); }))
          .child(this.picker(t, `pag-${task.id}`, agentOpts.find((o) => o.key === L.agent), agentOpts, (o) => { L.agent = o.key; })))
        .when(L.agent === CUSTOM, (el) => el.child(Input.new(L.custom).h(26).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12)))
        .child(box(L.msg))
        .child(h_flex().gap(8).items_center()
          .when(info === false && !!task.notes, (el) => el.child(link(`usenotes-${task.id}`, "Use notes", () => L.msg.set_value(task.notes))))
          .child(div().flex_1())
          .child(this.chip(t, `go-${task.id}`, L.busy ? "Launching…" : "Launch  ↵", true, (cx) => { if (!L.busy) cx.spawn((cx) => this.doLaunch(task, cx)); })))
        .when(!!L.error, (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(L.error))))
      .when(info, (el) => el.child(h_flex().gap(12).pt(2).justify_end()
        .child(link(`arch-${task.id}`, "Archive", (cx) => { this.open = null; this.change((b) => { b.tasks = b.tasks.filter((x) => x.id !== task.id); b.archive.push({ ...task, archived: Date.now() }); }, cx); }))
        .child(link(`del-${task.id}`, "Delete", () => { this.ask(`Delete "${task.title}"?`, (cx) => { this.open = null; this.change((b) => { b.tasks = b.tasks.filter((x) => x.id !== task.id); }, cx); }); }))));
  }

  column(t, col, now) {
    const inbox = col.id === INBOX;
    const showLine = (i) => this.drag && this.press?.kind && this.over?.col === col.id && this.over.index === i;
    const line = () => div().h(2).w_full().rounded(1).bg(t.accent);
    const cards = [];
    col.items.forEach((item, i) => { if (showLine(i)) cards.push(line()); cards.push(this.card(t, col, item, i, now)); });
    if (showLine(col.items.length) || (showLine(Infinity))) cards.push(line());
    if (this.rename?.kind === "new" && this.rename.id === col.id) {
      cards.unshift(v_flex().id(`draft-${col.id}`).p(10).rounded(8).border(1).border_color(t.accent).bg(t.surface)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.field(t, this.rename.state))
        .child(div().pt(4).text_size(11).text_color(t.dim).child("Enter to add · Esc to cancel")));
    }
    const header = h_flex().id(`ch-${col.id}`).h(32).px(4).gap(4).items_center().flex_none()
      .child(this.rename?.kind === "column" && this.rename.id === col.id
        ? this.field(t, this.rename.state)
        : div().text_size(12).font_medium().text_color(t.muted).child(col.name))
      .child(div().text_size(11).text_color(t.dim).child(String(col.items.length)))
      .child(div().flex_1())
      .when(!inbox && col.id === this.doneColumn()?.id && col.items.length > 0, (el) => el.child(this.chip(t, `clear-${col.id}`, "Clear", false, (cx) => this.clearDone(cx))))
      .when(!inbox, (el) => el
        .child(div().id(`cmb-${col.id}`).px(5).rounded(4).text_size(13).text_color(this.colMenu === col.id ? t.foreground : t.dim).cursor_pointer().tooltip("Column")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.colMenu = this.colMenu === col.id ? null : col.id; cx.notify(); }).child("⋯"))
        .child(this.iconButton(t, `add-${col.id}`, "plus", "New task (n)", (cx) => this.addTask(col.id, cx), "n", this.sel.c === col.index)));
    const menu = this.colMenu === col.id
      ? v_flex().mx(4).mb(6).p(3).rounded(6).border(1).border_color(t.border).bg(t.popover)
        .children([["rename", "Rename"], ["left", "Move left"], ["right", "Move right"], ["before", "Add column before"], ["add", "Add column after"], ["delete", "Delete column"]]
          .map(([a, l]) => div().id(`cm-${col.id}-${a}`).h(24).px(8).flex().items_center().rounded(4).text_size(12).cursor_pointer()
            .text_color(a === "delete" ? t.blocked : t.foreground).hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { this.columnAction(a, col.id, cx); cx.notify(); })
            .child(l)))
      : null;
    return v_flex().id(`col-${col.id}`).w(COL_W).h_full().flex_none().min_h(0)
      .child(header)
      .when(!!menu, (el) => el.child(menu))
      .child(v_flex().id(`cb-${col.id}`).flex_1().min_h(0).overflow_y_scroll().gap(6).pb(40)
        .on_mouse_move((e, cx) => this.track(e, { col: col.id, index: col.items.length }, cx))
        .children(cards)
        .when(col.items.length === 0 && inbox, (el) => el.child(div().px(4).text_size(11.5).text_color(t.dim).child("Agents you start in Herdr wait here until you give them a task."))));
  }

  bottomBar(t) {
    const b = this.bar;
    if (!b) return null;
    const box = h_flex().id("bar").flex_none().h(36).px(14).gap(10).items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(12.5).text_color(t.foreground);
    if (b.kind === "note") return box.child(b.text).child(div().flex_1()).child(this.chip(t, "bar-ok", "OK", false, () => { this.bar = null; }));
    if (b.kind === "help") return box.child(div().text_color(t.dim).child(`Corral Board ${BUILD}`)).child(div().text_color(t.muted).child("h l columns · j k cards · H L move · K J reorder · m move to… · space done · n new · e rename · i notes · a launch · enter agents (j k · enter opens · d/x off the task) · 1–9 agent · x archive · d delete · X clear done · / filter · ? close")).child(div().flex_1()).child(this.chip(t, "bar-x", "Close", false, () => { this.bar = null; }));
    if (b.kind === "move") return box.child("Move to:").children((this.cols ?? []).slice(1).map((c, i) => div().text_color(t.muted).child(`${i + 1} ${c.name}`)));
    return box.child(b.text)
      .when(!!b.never, (el) => el.child(this.chip(t, "bar-never", `${b.neverOn ? "☑" : "☐"} Don't ask again`, false, () => { b.neverOn = !b.neverOn; })))
      .child(div().flex_1())
      .child(this.chip(t, "bar-yes", "Yes (y)", true, (cx) => {
        if (b.neverOn) this.change((bd) => { bd.prefs = { ...bd.prefs, confirmDone: false }; }, cx);
        this.bar = null; b.yes(cx);
      }))
      .child(this.chip(t, "bar-no", "No (n)", false, (cx) => { this.bar = null; b.no?.(cx); }));
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
    const taskOf = (addr) => this.board.tasks.find((tk) => tk.agents.some((r) => r.address === addr))?.title;
    return h_flex().id("nextup").flex_none().h(34).px(14).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).overflow_hidden()
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Next up"))
      .children(waiting.map(({ a }) => {
        const term = this.terms.get(a.address);
        const sp = spaces().find((x) => x.id === a.space);
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
    const count = agents().filter((a) => !terminals().find((x) => x.address === a.address)?.labels?.["corral.task"]).length;
    return h_flex().id("pill").h(26).px(10).gap(6).items_center().text_size(12).cursor_pointer()
      .text_color(showing ? t.accent : t.foreground)
      .on_click((_e, cx) => { flip(); askFocusSoon(cx); cx.notify(); })
      .child(svg(`${ICONS}/layers.svg`).size(13))
      .child(showing ? "Terminals" : "Board")
      .when(!showing && count > 0, (el) => el.child(div().text_color(t.dim).child(String(count))));
  }

  render(cx) {
    const t = theme();
    if (this.role === "pill") return this.pill(t);
    const now = Date.now();
    this.terms = new Map(terminals().map((x) => [x.address, x]));
    this.ags = new Map(agents().map((a) => [a.address, a]));
    const cols = this.shown(this.terms, this.ags).map((c, index) => ({ ...c, index }));
    this.cols = cols;
    // A task moved by key stays selected once it shows up in its new column.
    if (this.follow) {
      const i = cols[this.follow.c]?.items.findIndex((x) => x.kind === "task" && x.task.id === this.follow.id) ?? -1;
      if (i >= 0) { this.sel = { c: this.follow.c, i }; this.follow = null; }
    }
    const inOverlay = !!props()?.overlay;
    // Focus can't move during render: do it from a task, right after. Asked for by flip() through shared state,
    // because a hidden copy doesn't render and can't notice it became visible.
    const ask = shared("corral.focusAt") ?? 0;
    // Only once actually shown (the request can arrive while the stack still shows the terminals), and again
    // shortly after, in case the app hands the keyboard back to the terminal pane after the switch.
    const shown = inOverlay || find(layout(), "corral-view")?.active === "board";
    if (shown && (ask !== this.focusedAt || (inOverlay && !this.focusedAt))) {
      this.focusedAt = ask || 1;
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
      .on_mouse_down("left", (_e, cx) => { this.focus.focus(); this.colMenu = null; cx.notify(); })
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
        .child(this.kbd(t, "/"))
        .child(div().w(180).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.filterState).h(26).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_size(12)))
        .child(div().flex_1())
        .child(this.chip(t, "new-task", "+ Task", false, (cx) => this.addTask(this.board.columns[0]?.id, cx)))
        .child(this.chip(t, "keys", "?", this.bar?.kind === "help", () => { this.bar = this.bar?.kind === "help" ? null : { kind: "help" }; }))
        .child(inOverlay
          ? this.chip(t, "close", "Close", false, () => closeOverlay(props().overlay))
          : find(layout(), "corral-view") ? this.chip(t, "back", "← Terminals", false, () => flip("main")) : div()))
      .when(!!this.nextUp(t, now), (el) => el.child(this.nextUp(t, now)))
      .when(!!s.error || s.readOnly, (el) => el.child(div().px(14).py(6).bg(alpha(t.blocked, "22")).text_size(12).text_color(t.blocked)
        .child(s.error ?? "This board was made by a newer Corral Board; it is shown read-only.")))
      // Sideways scrolling is ours: only a swipe's horizontal part (or shift + wheel) moves the board,
      // so a vertical swipe that reaches a column's end never turns into a sideways scroll.
      .child(div().id("cols-view").flex_1().min_h(0).w_full().relative().overflow_hidden()
        .on_size_change((size, cx) => { this.viewW = size.width; cx.notify(); })
        .on_scroll_wheel((e, cx) => {
          const dx = e.modifiers?.shift && !e.delta.x ? e.delta.y : e.delta.x;
          if (!dx) return;
          const max = Math.max(0, cols.length * (COL_W + 10) + 10 - (this.viewW ?? 0));
          const next = Math.max(0, Math.min(max, (this.scrollX ?? 0) - dx));
          if (next !== this.scrollX) { this.scrollX = next; cx.notify(); }
        })
        .child(h_flex().id("cols").absolute().top(0).bottom(0).left(-(this.scrollX ?? 0)).p(10).gap(10).items_start()
          .children(cols.map((c) => this.column(t, c, now)))))
      .when(!!this.bottomBar(t), (el) => el.child(this.bottomBar(t)))
      .when(!!ghost, (el) => el.child(ghost));
  }
}
