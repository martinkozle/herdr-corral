# herdr-corral

My setup for the [Herdr app](https://herdr.dev): a Kanban board where your
tasks hold the coding agents you start for them, packaged as a layout plus
small mods. Each mod works on its own.

- **Corral Board** (`mods/corral-board`): your own columns and tasks; each
  task holds its agents with their Herdr status and a Claude prompt-cache
  countdown; an Inbox of agents not on a task yet; drag and drop; launch or
  resume an agent from a task; keyboard-driven too (`?` on the board).
- **Corral layout** (`layouts/corral.json`): Herdr's main window with the
  board one key (`cmd-shift-k`) or one click away.

Status: `0.1.0`, the first version in daily use. Built on herdr-app 0.1.12.

## Use the whole setup

Ask your agent in Herdr: "add the layout from github.com/martinkozle/herdr-corral".
It copies `layouts/corral.json` and `mods/corral-board`, merges `keys.json`
into yours, and switches to the `corral` layout. `ctrl-shift-l` switches
back.

## Take a piece

Each folder under `mods/` stands alone with its own `RECIPE.md`:

- `corral-board`: in any layout, `cmd-shift-k` (`mod.open:corral-board`)
  opens it as a window.

If the files don't work on your Herdr version, have your agent rebuild from the
`RECIPE.md`. The recipes are the source of truth; the code is one build of them.

## What it touches

The board runs `herdr-app` and `hc` (to start agents and label their
terminals), and `find`, `tail`, `ls`, `rm`, `mkdir`. It reads Claude Code's
`~/.claude/sessions/` and `~/.claude/projects/` (for the cache countdown and
resume) and keeps its data in `~/.config/herdr-app/corral/` (`board.json`
plus its last 50 versions in `backups/`). No network.

There's no undo in the board: to undo a change, restore a file from
`corral/backups/` over `board.json` (or ask your agent to); the board reloads
by itself.

## Developing

Herdr's hot reload doesn't follow a symlinked mod folder, so edit here and run
`scripts/dev-sync.sh`: it copies `mods/*` into `~/.config/herdr-app/mods/` and
runs `herdr-app check`. Bump `BUILD` in `main.js` on every change; the board's
header shows which build is running. Render errors only show in the window, so
look at it (`herdr-app shot`).

## Later

- "Next up": Claude agents ordered by cache expiry, soonest first.
- Undo in the board; a view of archived (and deleted) tasks.
- Keyboard control of the launch form's space and agent pickers.
- Space tiles in the launch form; highlight all tasks of one space.
- A prefilled, unsent first message; a "new git worktree" option on launch
  (Herdr's `worktree` mod, `{branch, argv}`).
- `corral-agents`: Herdr's agents list plus a cache-warmth sort and task
  names. Experimental, may never ship.
- PR links on tasks.
- Cache countdown and resume for Codex and OpenCode, and for agents on other
  machines.
- `preview.png` for the layout and the board (from a demo board).
