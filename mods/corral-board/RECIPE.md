# Corral Board

A Kanban board for your own tasks, each holding the coding agents you started
for it. You move tasks through your columns by dragging; each agent's Herdr
status and its Claude prompt-cache countdown show on the card, so you can see
at a glance which agent to answer before its cache goes cold. Agents you start
anywhere in Herdr wait in an Inbox until you give them a task.

![Corral Board](preview.png)

Built and used on herdr-app 0.1.12 / hc 0.1.17 (build `0.1.0`).

## What you see

One full-size view on `canvas`, top to bottom:

- **Header** (40px, `chrome`, bottom `border`): "Corral" (13px semibold), the
  build (`0.1.0`, 10.5px `dim`), a ⌨ mark (`accent` while the board has the
  keyboard, faint `dim` when a click is needed first), a faint `/` hint, the
  filter field (180px, "Filter tasks"), then on the right "+ Task", "?" (lit
  while the key help shows), and "← Terminals" (corral layout) or "Close"
  (window).
- **Columns**, 280px wide, 10px apart, starting 10px in. Each scrolls
  vertically on its own; the row of columns scrolls sideways.
  - **Column header** (32px): name (12px medium `muted`), task count (11px
    `dim`), then "⋯" (column menu) and "+" (new task). The Done column also
    has "Clear" while it holds tasks.
  - **Inbox** is always first: no menu, no "+", can't be moved or deleted.
- **Default columns:** To do · In progress · Review · Waiting on others ·
  Waiting on build · Parked · Done.
- **Task card** (`surface`, 1px `border`, radius 8, 10px padding, 6px apart;
  `accent` border when selected):
  - Title (13px medium, wraps), then on the right: pencil (rename), "+"
    (launch an agent), "⋯" (Archive, Delete).
  - Notes: a faint box under the title (`background` at 50%), "Add notes…"
    when empty, the text in `muted` otherwise. Always shown.
  - Agent rows, live ones first, then ended ones. Each row is its own block
    (6px radius, `foreground` at 4% for live rows, untinted for ended), 4px
    apart:
    - left: its number (1–9, a faint hint), the program icon (14px);
    - middle: the agent's name (12px, wraps in full), and under it the
      space's tile (13px square, its first letter on its color) and name
      (10.5px `dim`);
    - right, stacked: the status, and under it the cache badge; then "×".
  - **Ended** rows: name in `dim`, "ended" on the right. An ended Claude agent
    whose conversation is on disk instead shows "↻ resume" and a dashed
    `input` border.
- **Inbox card**: a dashed-looking card (`background`, `input` border) with
  the agent's name, its icon, space tile and name, cache badge and status.
- **Status** (as in Herdr's agents list): working = a 12px ring spinning in
  `working`; blocked = a "Needs you" pill (`blocked` on 15% `blocked`) with
  Claude's reason as a tooltip ("input needed"); done = a 7px `done` dot; idle
  = a 7px `idle` ring.
- **Cache badge** (Claude agents only): minutes left ("47m", "<1m") on a pill
  whose color follows the share of the cache's own lifetime left: full =
  `ansi2`, half = `ansi3`, none = `ansi1` (pill at 20%, text full). Expired:
  "cold" in `dim`, no pill. Unknown: nothing.
- **Key hints:** faint letters inside their buttons (pencil `e`, "+" `a`,
  column "+" `n`, notes `i`, agent numbers). They show on a hovered or
  selected card, and on the selected column; hidden ones keep their space.
- **Bottom bar** (36px, `chrome`), only when needed: a confirmation ("Delete
  …?" Yes (y) / No (n), "Don't ask again" on Move to Done), the "Move to:"
  list, the key help, or a note ("Move its tasks first.").

## How it behaves

- **Tasks and agents are separate.** A task's column changes only when you
  move it. Agent status is Herdr's; nothing an agent does moves its task.
- **Inbox:** every Herdr agent in no task. Not stored: an entry disappears
  when its agent ends. Sub-agents never appear. Clicking an entry goes to the
  agent; renaming it (`e`) or dragging it to a column makes it a task.
- **Drag** (press, move 4px): a ghost card follows the pointer, the lifted
  card fades to 35%, and an `accent` line shows where it lands.
  - A task → a column: placed at the line.
  - An Inbox entry → a column: a new task holding that agent.
  - An Inbox entry or an agent row → the middle of a task card (the card
    lights up): the agent joins that task (leaving its old one).
  - An agent row → a column's empty space: a new task with it.
  - An agent row → the Inbox: it leaves its task.
  - A release never also counts as a click.
- **Click** a card: select it. **Double-click** a title: rename. **Click** the
  notes: edit them in place, with Cancel and "Save ↵" and a "⇧↵ new line"
  hint; Enter saves, Shift+Enter is a new line, clicking away saves, Esc
  closes unchanged notes and asks "Discard your changes to the note?"
  otherwise. **Click** an agent row: go to it. **Click** a "↻ resume" row:
  resume it.
- **Launch** ("+" or `a`): the card opens a form with a space and an agent
  dropdown (the task's last space; your first installed agent; or "Custom
  command…", a command field remembered for next time), and a first-message
  box (focused; "Use notes" copies the notes in). Enter or "Launch ↵" starts
  a tab named after the task ("<title> 2", "3"… for later agents) in that
  space, sends the message if there is one, adds the agent to the task, and
  goes to it.
- **Resume:** `claude --resume <session>` in a new tab in the agent's old
  folder; the row then follows the new agent.
- **"×" on an agent row** (or `d`/`x` while it's picked): the agent leaves the
  task and goes back to the Inbox. Its terminal keeps running.
- **Column menu (⋯):** Rename, Move left, Move right, Add column before, Add
  column after, Delete column. Deleting a column that holds tasks is refused.
- **Archive** (`x`, or ⋯): the task leaves the board into the file's archive.
  **Delete** (`d`, or ⋯) asks first. **Clear** archives everything in Done.
  There's no archive view yet.
- **Filter:** shows tasks whose title, notes or agent names contain the text,
  and Inbox entries whose name does.
- **Keys** (only while the board has the keyboard; text fields take every key):

  | Key | Action |
  |---|---|
  | `h` `l` / ← → | previous / next column |
  | `j` `k` / ↓ ↑ | next / previous card |
  | `g` `G` | first / last card |
  | `H` `L` / shift-← → | move the card to the previous / next column |
  | `K` `J` / shift-↑ ↓ | move the card up / down |
  | `m` | "Move to:", then 1–9 picks a column |
  | `space` | move the card to Done (asks, with "Don't ask again") |
  | `n` | new task in this column (a draft card: Enter adds, Esc cancels) |
  | `e` | rename the card (an Inbox entry: make it a task) |
  | `i` | edit the card's notes |
  | `a` | launch an agent from the card |
  | `enter` | pick one of the card's agents: `j` `k` move, `enter` goes to it or resumes it, `d`/`x` take it off the task, anything else leaves (only `h` `l` carry on) |
  | `1`–`9` | go to (or resume) the card's Nth agent |
  | `x` | archive the card |
  | `d` | delete the card (asks) |
  | `X` | archive everything in Done (asks) |
  | `/` | filter; `esc` clears it |
  | `?` | key help (again: closes) |

- **Opening the board.** In the corral layout: the floating pill, or
  `cmd-shift-k`, flips the work area between terminals and board; the board
  takes the keyboard when it shows, the terminal pane gets it back when it
  hides. Elsewhere: `cmd-shift-k` opens the board as a window (90%×85%) and
  closes it again.
- **Live.** The board redraws on Herdr's data changes, reloads when
  `board.json` changes on disk, re-reads a Claude transcript when it changes,
  and checks everything every 30s (the countdown, session ids, rejoining
  agents). Nothing animates on a timer.

## Built from

- **Folder** `mods/corral-board/`: `main.js` (the view), `store.js` (load,
  migrate, save, backups), `cache.js` (Claude cache), `mod.json` `{ "place":
  "none", "title": "Corral Board", "focusable": true, "overlay": { "kind":
  "window", "width": 0.9, "height": 0.85 } }`, `jsconfig.json` (`checkJs`).
  Plain JavaScript, no npm packages, no bundler.
- **Props:** none → the board; `{ role: "pill" }` → the corral layout's
  floating toggle ("Board" + Inbox count, or "Terminals" while the board
  shows), which also receives `corral-board.toggle`.
- **State:** `~/.config/herdr-app/corral/board.json`, read with
  `readTextFile`, written with `writeTextFile(path, text, expected)` (refused
  when stale: reload, re-apply, retry up to 3 times), watched with
  `watchFolder`. Before each save the replaced version goes to
  `corral/backups/board-<UTC time>.json`; the newest 50 are kept. Not inside
  the mod folder: a write there would reload the mod.

  ```json
  { "schema": 1,
    "columns": [ { "id": "todo", "name": "To do" } ],
    "tasks": [ {
      "id": "t-mvzb7etqk4u0", "title": "Fix login", "notes": "", "column": "todo",
      "space": "spfa98…", "created": 1793614046059, "updated": 1793614046059,
      "agents": [ { "address": "t7", "app": "claude-code", "name": "Fix login",
                    "space": "spfa98…", "started": 1793614046059,
                    "session": "531369f2-…", "cwd": "/Users/me/dev/app" } ] } ],
    "archive": [],
    "prefs": { "confirmDone": true, "customCommand": "pi --model x" } }
  ```

  Order within a column is order in `tasks`. Ids are never reused. `session`
  and `cwd` are set only for Claude agents whose conversation is on disk. On
  load, a lower `schema` runs each migration in turn; a higher one shows the
  board read-only with a banner and never writes.
- **Binding:** the task lists the agent's address, and the terminal carries
  `corral.task=<task id>` (`hc label <t> corral.task=<id>`; `corral.task=`
  removes it). Every 30s, live terminals that carry the label and run an agent
  (`report.app`) rejoin their task if it lost them. A listed address counts as
  that agent only while its terminal still carries the task's label and runs
  an agent; otherwise the row is "ended".
- **Launch / resume:** `exec("herdr-app", ["do", "tab.new", JSON.stringify({
  space, name, argv, task?, folder? })])` → `{ space, tab, terminal }`, then
  the label, then `pane.focus {terminal}`. Custom commands are split on
  spaces, quotes kept together; no shell syntax.
- **Cache** (`cache.js`, Claude only, local agents): `terminals()[i].
  foreground.pid` → `~/.claude/sessions/<pid>.json` (`sessionId`, `cwd`,
  `status`, `waitingFor`) → `exec("find", …)` once for
  `~/.claude/projects/*/<sessionId>.jsonl` → `exec("tail", ["-c", "2000000",
  path])`. TTL = 1h if the last `api-request` line with `querySource ===
  "repl_main_thread"` has a `cacheControl[].value.ttl` of `"1h"`, else 5m (the
  last known one if none is in the tail). Expiry = last `assistant`
  `timestamp` + TTL. `watchFolder` on each transcript's folder re-reads it.
- **Space tiles:** the first letter of the space's name on the color the
  shipped `spaces` mod assigned (shared `"space.colors"`: id → `ansiN`), from
  a copy of its table: `ansi6 #22a99a`, `ansi3 #e3814f`, `ansi4 #5b8def`,
  `ansi5 #8b7cf6`, `ansi2 #3fae6a`, `ansi1 #d9649a` (default `ansi6`).
- **Herdr data:** `agents()`, `terminals()`, `spaces()`, `machines()`,
  `knownAgents()`, `theme()`, `layout()`, `focused()`, `shared()`.
  **Commands:** `layout.select`, `pane.focus`. **Programs:** `herdr-app`,
  `hc`, `find`, `tail`, `ls`, `rm`, `mkdir`. No network.

## Watch out

- **Hot reload doesn't follow a symlinked mod folder.** Copy the folder into
  `mods/` (this repo: `scripts/dev-sync.sh`), and bump `BUILD` in `main.js` on
  every change: the header shows which build is running.
- **`herdr-app check` and `herdr-app status` miss render errors** in parts
  the first render doesn't reach (agent rows, cards). The window shows "This
  view could not be re-rendered" instead. Look at the running board
  (`herdr-app shot`) after each change.
- **Tasks spawned from `render` never run**, silently. Focus can't move from
  `render` either. The board starts one long-lived task in `init` and wakes
  it from `render` to take the keyboard.
- **A hidden stack child doesn't render.** A request made while it's hidden
  (the flip's focus request) must be repeated after it shows: the pill asks
  again 120ms after flipping.
- **`pane.focus` then `focused()`:** `focused()` hasn't caught up yet; refocusing
  "the focused pane" right after a `pane.focus` undoes it.
- **`cx.bind_keys` bindings are app-wide and outlive the mod** (until Herdr
  restarts); a removed one fails as an unknown command. Don't use them.
- **A textarea's `submit` fires on every Enter**, with `shift` / `secondary`
  flags; on Shift+Enter it also inserts the line break itself. `cmd-enter` is
  taken by the textarea on macOS.
- **Theme colors may carry alpha** (`#ffffff18`): cut to `#rrggbb` before
  adding one. `flex_shrink` needs its number.
- **Element events:** a press on a text field must stop propagation, or the
  board's own press handler takes the keyboard back. A drag's release also
  fires `on_click` on what's under it.
- **The textarea's cursor** starts at 0; `set_selected_range` after `focus()`
  puts it at the end.
- `tab.new` runs the agent in your shell, which stays when the agent exits:
  "ended" means no agent runs there, not that the terminal finished. Claude
  writes `sessions/<pid>.json` at start but the transcript only with the first
  message; `claude --resume` refuses a session without one.
- An unavailable machine makes its agents "away", never "ended".
- The space tile colors are a copy of the `spaces` mod's table; a Herdr that
  changes them needs the copy updated.
- The cache color is relative to each cache's own lifetime; read the minutes
  to compare agents. Codex, OpenCode and remote agents get no cache badge.
- `board.json` must stay under 1 MiB (`readTextFile`); the archive is what
  grows.

## Done when

- `herdr-app check mods/corral-board` passes and the header shows the build.
- A new board shows Inbox plus the seven default columns; running agents are
  in the Inbox.
- Column "+" shows a draft card: Enter adds the task, Esc adds nothing; the
  task survives a Herdr restart.
- A task dragged to the fourth spot of another column lands there; dragging an
  Inbox entry onto a task adds the agent (`hc get <t>` shows `corral.task`);
  dragging an agent row back to the Inbox removes it and its label.
- Launch opens a named tab in the chosen space with the agent running, its row
  on the card, and Herdr showing it.
- A Claude agent's badge matches its transcript's last reply + TTL, and turns
  "cold" after; once it exits, its row offers "↻ resume", which reopens the
  conversation.
- In the corral layout `cmd-shift-k` flips to the board and `j` works at once;
  flipping back lets you type in the terminal at once.
- Enter saves notes; Shift+Enter adds one line break; Esc on changed notes
  asks first.
- Deleting a non-empty column is refused; Clear empties Done into `archive`.
- Every save adds a file to `corral/backups/`; never more than 50.
- Editing `board.json` by hand shows on the board without a restart; a
  `schema: 99` board opens read-only and is never written.
