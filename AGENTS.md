# Working on herdr-corral

A Herdr app layout (`layouts/corral.json`) plus the Corral Board mod
(`mods/corral-board`). Read `mods/corral-board/RECIPE.md` before changing the
board: it is the spec, and its Watch out section lists every trap found so far.
A local `STATE.md` (git-ignored, never commit it) may hold the maintainer's
current status and notes; read it too if it exists.

## Dev loop

- Edit in this repo, then run `scripts/dev-sync.sh`: it copies the mods into
  `~/.config/herdr-app/mods` (hot reload doesn't follow a symlink) and runs
  `herdr-app check` on each. Trust that check, not `node --check`; a render
  error only shows in the window.
- Look at the result with `herdr-app shot`. Don't press keys or move the
  mouse in someone's open window: ask them to try interactions, and say
  plainly what you couldn't verify.
- The board runs two ways; check a change that touches focus or keys in both:
  in the `corral` layout (flipped with `cmd-shift-k`) and as a popup
  (`herdr-app do mod.open --name corral-board`).
- Demo data instead of the real board: `<appHome>/corral/demo.json` (see
  the recipe's Demo mode; `scripts/demo-board.json` is the one behind
  `preview.png`).

## Versions

- One version, `0.1.N`, shown in the board's header (`BUILD` in
  `mods/corral-board/main.js`) and stated in `README.md` (Status) and the
  recipe (build).
- Bump `BUILD` on every change you sync, so the header shows which build is
  running: between releases as `0.1.N-dev.M`.
- Only the commit that gets pushed carries the plain `0.1.N`, with README and
  recipe matching. One pushed commit, one version; its message starts with
  "Corral Board 0.1.N: " and says what changed.

## Releasing

- `main` is what people install: herdr.dev lists the repo by its topics
  (`herdr-mod`, `herdr-layout`) and the layout recipe's first paragraph, and
  copies whatever is on `main`. There are no tags or GitHub Releases.
- A fix for a GitHub issue goes through a PR with `Fixes #N`, credited to the
  reporter. Merge it by fast-forwarding `main` locally and pushing (GitHub
  marks the PR merged and closes the issue), so the signed commit is what
  lands. Other changes push to `main`.
- Commit and push only when the maintainer says so. Before pushing, check the
  author email and signature (`git log --format='%h %ae %G?'`).
- Keep the recipe in step with the code in the same commit; a new trap goes
  into its Watch out section.
