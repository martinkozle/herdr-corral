// The board file: load, migrate, save with optimistic concurrency, watch.
import { appHome, readTextFile, writeTextFile, exec } from "herdr";

export const SCHEMA = 1;
export const DIR = () => `${appHome()}/corral`;
export const FILE = () => `${DIR()}/board.json`;
// Every save first copies the version it replaces here; the newest KEEP stay. There's no undo in the board:
// a bad change is undone by hand (or by an agent) from these.
export const BACKUPS = () => `${DIR()}/backups`;
const KEEP = 50;

const DEFAULT_COLUMNS = [
  ["todo", "To do"], ["doing", "In progress"], ["review", "Review"],
  ["others", "Waiting on others"], ["build", "Waiting on build"],
  ["parked", "Parked"], ["done", "Done"],
].map(([id, name]) => ({ id, name }));

export const newId = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function emptyBoard() {
  return { schema: SCHEMA, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), tasks: [], archive: [], prefs: { confirmDone: true } };
}

// Each entry upgrades a board from schema n to n + 1.
const MIGRATIONS = {};

function migrate(b) {
  while (b.schema < SCHEMA) b = MIGRATIONS[b.schema](b);
  return b;
}

export class Store {
  constructor() {
    this.board = emptyBoard();
    this.text = null; // the file as last read or written: the expected value for the next write
    this.readOnly = false;
    this.error = null;
  }

  async load() {
    const text = await readTextFile(FILE());
    if (text === this.text && text !== null) return false;
    this.text = text;
    if (text === null) { this.board = emptyBoard(); return true; }
    try {
      const b = JSON.parse(text);
      if ((b.schema ?? 0) > SCHEMA) { this.readOnly = true; this.board = b; return true; }
      this.board = migrate(b);
      this.error = null;
    } catch (e) {
      this.error = `board.json is not valid JSON: ${e.message}`;
      this.readOnly = true;
    }
    return true;
  }

  // Applies fn to the board and saves. A stale file (changed elsewhere) is reloaded and fn applied again.
  async change(fn) {
    if (this.readOnly) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = JSON.parse(JSON.stringify(this.board));
      fn(next);
      const text = JSON.stringify(next, null, 1);
      try {
        if (this.text === null) await exec("mkdir", ["-p", DIR()]);
        const before = this.text;
        await writeTextFile(FILE(), text, before);
        this.board = next;
        this.text = text;
        if (before) await this.backup(before);
        return;
      } catch (e) {
        this.text = undefined; // force a reload
        await this.load();
      }
    }
    this.error = "Couldn't save the board (it kept changing on disk).";
  }

  // Keeps the replaced version as backups/board-<time>.json, then drops all but the newest KEEP.
  // A failed backup never fails the save.
  async backup(text) {
    try {
      if (!this.backupsReady) { await exec("mkdir", ["-p", BACKUPS()]); this.backupsReady = true; }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await writeTextFile(`${BACKUPS()}/board-${stamp}.json`, text, null);
      const list = await exec("ls", ["-1", BACKUPS()]);
      const old = list.stdout.split("\n").filter((f) => /^board-.*\.json$/.test(f)).sort().slice(0, -KEEP);
      if (old.length) await exec("rm", ["-f", ...old.map((f) => `${BACKUPS()}/${f}`)]);
    } catch (_e) { /* best effort */ }
  }
}
