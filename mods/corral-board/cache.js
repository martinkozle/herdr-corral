// Claude Code prompt-cache warmth, per terminal. Ported from excaliagent's sources:
// foreground pid → ~/.claude/sessions/<pid>.json → sessionId → transcript tail.
import { exec, home, readTextFile, watchFolder } from "herdr";

const TAIL_BYTES = "2000000";
const TTL = { "1h": 3600000, "5m": 300000 };

export class Cache {
  constructor() {
    this.byPid = new Map(); // pid → { sid, path, ttl, expires, waitingFor, status }
    this.watched = new Set();
  }

  info(pid) {
    return this.byPid.get(pid) ?? null;
  }

  // Refreshes every local Claude terminal. onChange runs when something changed.
  async refresh(terms, cx, onChange) {
    for (const t of terms) {
      const pid = t.foreground?.pid;
      if (!pid || t.address.includes("/") || t.report?.app !== "claude-code") continue;
      try {
        await this.one(pid, cx, onChange);
      } catch (_e) { /* a session that just ended: try again next time */ }
    }
    onChange();
  }

  async one(pid, cx, onChange) {
    const raw = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
    if (!raw) return;
    const s = JSON.parse(raw);
    const prev = this.byPid.get(pid);
    const e = prev?.sid === s.sessionId ? prev : { sid: s.sessionId, path: null, ttl: null, expires: 0 };
    e.status = s.status;
    e.cwd = s.cwd ?? null;
    e.waitingFor = s.waitingFor ?? null;
    if (!e.path) {
      const r = await exec("find", [`${home()}/.claude/projects`, "-maxdepth", "2", "-name", `${s.sessionId}.jsonl`]);
      e.path = r.stdout.trim().split("\n")[0] || null;
    }
    this.byPid.set(pid, e);
    if (!e.path) return;
    await this.read(e);
    const dir = e.path.slice(0, e.path.lastIndexOf("/"));
    if (!this.watched.has(dir)) {
      this.watched.add(dir);
      cx.spawn(async (cx) => {
        for (;;) {
          const changed = await watchFolder(dir);
          for (const v of this.byPid.values()) if (changed.includes(v.path)) await this.read(v);
          onChange();
          cx.notify();
        }
      });
    }
  }

  async read(e) {
    const r = await exec("tail", ["-c", TAIL_BYTES, e.path]);
    let last = null;
    let ttl = null;
    for (const line of r.stdout.split("\n").slice(1)) {
      if (!line.startsWith("{")) continue;
      if (!line.includes('"assistant"') && !line.includes('"api-request"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === "assistant" && j.timestamp) last = j.timestamp;
      if (j.type === "api-request" && j.querySource === "repl_main_thread") {
        ttl = (j.cacheControl ?? []).some((c) => c?.value?.ttl === "1h") ? "1h" : "5m";
      }
    }
    e.ttl = ttl ?? e.ttl ?? "5m";
    e.expires = last ? Date.parse(last) + TTL[e.ttl] : 0;
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
