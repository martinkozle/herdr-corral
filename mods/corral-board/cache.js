// Claude Code prompt-cache warmth, per terminal. Ported from excaliagent's sources:
// foreground pid → ~/.claude/sessions/<pid>.json → sessionId → transcript tail.
// Works on other machines too (`on`): their files are read through herdr-core, and polled on each
// refresh instead of watched (watchFolder is local only).
import { exec, home, machines, readTextFile, watchFolder } from "herdr";

const TAIL_BYTES = "2000000";

// Pull/merge request links (GitHub, GitLab, Bitbucket Cloud and Bitbucket Server/Data Center) and Jira
// issue links (…/browse/KEY-12).
const PR_RE = /https?:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+(?:\/[\w.~-]+)*?\/-\/merge_requests\/\d+|bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+|[\w.-]+(?:\/[\w.~-]+)*?\/projects\/[\w~.-]+\/repos\/[\w.-]+\/pull-requests\/\d+|[\w.-]+(?:\/[\w.~-]+)*?\/browse\/[A-Z][A-Z0-9_]+-\d+)/g;
// Lines worth parsing for them (a cheap test before the regex).
const LINKY = ["/pull", "/merge_requests/", "/browse/"];

// The PR links in some text, in order of appearance, each once (its last appearance counts).
export function prLinks(text) {
  const seen = [];
  for (const m of text.matchAll(PR_RE)) { const u = m[0]; const i = seen.indexOf(u); if (i >= 0) seen.splice(i, 1); seen.push(u); }
  return seen;
}

// The repository a PR link is in (its last path name before the PR part), or null (a Jira link).
export function repoOf(url) {
  return url.match(/github\.com\/[^/]+\/([^/]+)\/pull\//)?.[1]
    ?? url.match(/\/([^/]+)\/-\/merge_requests\//)?.[1]
    ?? url.match(/\/repos\/([^/]+)\/pull-requests\//)?.[1]
    ?? url.match(/bitbucket\.org\/[^/]+\/([^/]+)\/pull-requests\//)?.[1]
    ?? null;
}

// The page a link's group opens: the repository a PR is in, the project a Jira issue is in (`/browse/KEY`).
export function groupUrl(url) {
  return url.replace(/\/(?:-\/merge_requests|pull|pull-requests)\/\d+$/, "").replace(/(\/browse\/[A-Z][A-Z0-9_]+)-\d+$/, "$1");
}

// "web-app #12" (GitLab: "web-app !12"); a Jira link: its key, "PROJ-12".
export function prLabel(url) {
  const jira = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)$/)?.[1];
  if (jira) return jira;
  const n = url.match(/(\d+)$/)?.[1];
  return `${repoOf(url) ?? "PR"} ${url.includes("/merge_requests/") ? "!" : "#"}${n}`;
}

// What links group by: the repository for a PR, the project key for a Jira issue.
export function linkGroup(url) {
  return url.match(/\/browse\/([A-Z][A-Z0-9_]+)-\d+$/)?.[1] ?? `${url.match(/^https?:\/\/([^/]+)/)?.[1]}/${repoOf(url)}`;
}

export const hostOf = (url) => url.match(/^https?:\/\/([^/]+)/)?.[1] ?? "";
const TTL = { "1h": 3600000, "5m": 300000 };

// The machine a terminal address lives on (`machine/t4`), null for this one.
const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const keyOf = (term) => (term?.foreground?.pid ? `${machineOf(term.address) ?? ""}|${term.foreground.pid}` : null);

// On another machine: prints the transcript's size, then the lines that matter from its tail, or
// exits 3 when the size is still what we read last time (nothing new to send over ssh).
const REMOTE_READ = `s=$(wc -c < "$1") || exit 1; [ "$s" = "$2" ] && exit 3; echo "$s"; tail -c "$3" "$1" | grep -F -e '"assistant"' -e '"api-request"' -e '/pull/' -e '/pull-requests/' -e '/merge_requests/' -e '/browse/'; exit 0`;

export class Cache {
  constructor() {
    this.byKey = new Map(); // "machine|pid" → { sid, path, ttl, expires, waitingFor, status, cwd, on, size }
    this.homes = new Map(); // machine → its home folder
    this.watched = new Set();
  }

  // The Claude session behind a terminal (from terminals()), or null.
  info(term) {
    const k = keyOf(term);
    return k ? this.byKey.get(k) ?? null : null;
  }

  async homeOf(on) {
    if (!on) return home();
    if (!this.homes.has(on)) {
      const r = await exec("printenv", ["HOME"], { on });
      const h = r.stdout.trim();
      if (r.code !== 0 || !h) throw new Error(`no home on ${on}`);
      this.homes.set(on, h);
    }
    return this.homes.get(on);
  }

  // Refreshes every Claude terminal, this machine's first. onChange runs when something changed.
  async refresh(terms, cx, onChange) {
    const ready = new Set(machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name));
    const claude = terms.filter((t) => t.foreground?.pid && t.report?.app === "claude-code");
    const local = claude.filter((t) => !machineOf(t.address));
    const remote = claude.filter((t) => ready.has(machineOf(t.address)));
    for (const t of [...local, ...remote]) {
      try {
        await this.one(t, cx, onChange);
      } catch (_e) { /* a session that just ended, or a machine that went away: try again next time */ }
    }
    onChange();
  }

  async one(term, cx, onChange) {
    const on = machineOf(term.address);
    const pid = term.foreground.pid;
    const h = await this.homeOf(on);
    const raw = await readTextFile(`${h}/.claude/sessions/${pid}.json`, { on });
    if (!raw) return;
    const s = JSON.parse(raw);
    const k = keyOf(term);
    const prev = this.byKey.get(k);
    const e = prev?.sid === s.sessionId ? prev : { sid: s.sessionId, path: null, ttl: null, expires: 0, on, size: null };
    e.status = s.status;
    e.cwd = s.cwd ?? null;
    e.waitingFor = s.waitingFor ?? null;
    if (!e.path) {
      const r = await exec("find", [`${h}/.claude/projects`, "-maxdepth", "2", "-name", `${s.sessionId}.jsonl`], { on });
      e.path = r.stdout.trim().split("\n")[0] || null;
    }
    this.byKey.set(k, e);
    if (!e.path) return;
    if (on) { await this.readRemote(e); return; }
    await this.read(e);
    const dir = e.path.slice(0, e.path.lastIndexOf("/"));
    if (!this.watched.has(dir)) {
      this.watched.add(dir);
      cx.spawn(async (cx) => {
        for (;;) {
          const changed = await watchFolder(dir);
          for (const v of this.byKey.values()) if (!v.on && changed.includes(v.path)) await this.read(v);
          onChange();
          cx.notify();
        }
      });
    }
  }

  async read(e) {
    const r = await exec("tail", ["-c", TAIL_BYTES, e.path]);
    // The first line is usually cut in half by tail.
    this.parse(e, r.stdout.split("\n").slice(1));
  }

  async readRemote(e) {
    const r = await exec("sh", ["-c", REMOTE_READ, "sh", e.path, String(e.size ?? ""), TAIL_BYTES], { on: e.on });
    if (r.code === 3) return; // unchanged
    if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    const lines = r.stdout.split("\n");
    e.size = lines[0].trim();
    // grep may keep tail's half first line; it then fails to parse and is skipped.
    this.parse(e, lines.slice(1));
  }

  parse(e, lines) {
    let last = null;
    let ttl = null;
    const prs = [];
    const said = new Map(); // link → when the transcript last mentioned it (ms)
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      if (LINKY.some((x) => line.includes(x))) {
        const found = prLinks(line);
        prs.push(...found);
        let at = null;
        try { at = Date.parse(JSON.parse(line).timestamp) || null; } catch { /* tail's half line */ }
        if (at) for (const u of found) said.set(u, at);
      }
      if (!line.includes('"assistant"') && !line.includes('"api-request"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === "assistant" && j.timestamp) last = j.timestamp;
      if (j.type === "api-request" && j.querySource === "repl_main_thread") {
        ttl = (j.cacheControl ?? []).some((c) => c?.value?.ttl === "1h") ? "1h" : "5m";
      }
    }
    // The last ten links the conversation mentions, newest last.
    if (prs.length) { e.prs = prLinks(prs.join(" ")).slice(-10); e.prAt = said; }
    e.ttl = ttl ?? e.ttl ?? "5m";
    // A tail with no assistant reply in it keeps what an earlier read found.
    e.expires = last ? Date.parse(last) + TTL[e.ttl] : e.expires;
  }
}

// Minutes left as text, and how much of its own lifetime is left (0..1); null when unknown.
export function warmth(e, now) {
  if (!e || !e.expires) return null;
  const left = e.expires - now;
  if (left <= 0) return { text: "cold", share: 0, cold: true };
  const m = Math.floor(left / 60000);
  return { text: m < 1 ? "<1m" : `${m}m`, share: Math.min(1, left / TTL[e.ttl]), cold: false };
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, f) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * f).toString(16).padStart(2, "0")).join("");

// Full = green, half = amber, none = red, in the theme's own ANSI colors.
export function warmthColor(t, share) {
  return share >= 0.5 ? mix(t.ansi3, t.ansi2, (share - 0.5) * 2) : mix(t.ansi1, t.ansi3, share * 2);
}
