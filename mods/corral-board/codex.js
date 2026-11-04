// Which Codex session each live Codex terminal runs, for `codex resume <id>` once it has ended.
// Codex records no process → session link: its TUI writes through a shared daemon and logs without a
// thread id. So this matches: the newest user session (`~/.codex/sessions/**/rollout-*.jsonl`, first
// line `session_meta`) started in the agent's folder after the agent's process did. Several Codex
// agents in one folder: newer processes take newer sessions first, and one that already has a session
// keeps it (after a `/new` there it can't be told which agent ran it: the old conversation beats the other
// agent's). Alone in its folder, `/new` moves along. An agent started with `codex resume <id>` keeps that id.
// (No hook can tell either: Codex runs hooks in its shared app-server, not in the terminal's process.)
import { exec } from "herdr";

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const keyOf = (term) => (term?.foreground?.pid ? `${machineOf(term.address) ?? ""}|${term.foreground.pid}` : null);
const SLACK_MS = 10000; // a session is written within a second or so of its process starting

// Prints "N <now>", "P <pid> <etime>" per process, then "R <first 2000 bytes>" per session file
// changed since the oldest process started.
const SCAN = `echo "N $(date +%s)"; m=1; for p in "$@"; do e=$(ps -o etime= -p "$p" | tr -d ' '); [ -n "$e" ] || continue; echo "P $p $e";
d=0; case "$e" in *-*) d=\${e%%-*}; e=\${e#*-};; esac; IFS=: read a b c <<EOF
$e
EOF
if [ -n "$c" ]; then s=$((d*86400 + 10#$a*3600 + 10#$b*60 + 10#$c)); else s=$((d*86400 + 10#$a*60 + 10#$b)); fi
[ $((s/60+2)) -gt $m ] && m=$((s/60+2)); done
find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mmin -$m 2>/dev/null | while read -r f; do printf 'R '; head -c 2000 "$f" | head -n 1; echo; done`;

// "[[dd-]hh:]mm:ss" → seconds.
function seconds(etime) {
  const [d, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const p = rest.split(":").map(Number);
  const [h, m, s] = p.length === 3 ? p : [0, ...p];
  return Number(d) * 86400 + h * 3600 + m * 60 + s;
}

export class Codex {
  constructor() {
    this.byKey = new Map(); // "machine|pid" → { sid, cwd }
  }

  info(term) {
    const k = keyOf(term);
    return k ? this.byKey.get(k) ?? null : null;
  }

  async refresh(terms, ready) {
    const codex = terms.filter((t) => t.foreground?.pid && t.report?.app === "codex" && t.state === "live");
    const byMachine = new Map();
    for (const t of codex) {
      const m = machineOf(t.address);
      if (m && !ready.has(m)) continue;
      if (!byMachine.has(m)) byMachine.set(m, []);
      byMachine.get(m).push(t);
    }
    for (const [m, ts] of byMachine) {
      try { await this.scan(m, ts); } catch (_e) { /* machine away or no ~/.codex: next time */ }
    }
  }

  async scan(on, terms) {
    // bash for 10#: ps prints "08" minutes.
    const r = await exec("bash", ["-c", SCAN, "scan", ...terms.map((t) => String(t.foreground.pid))], { on });
    if (r.code !== 0) throw new Error(r.stderr);
    let now = 0;
    const started = new Map(); // pid → ms
    const sessions = [];
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("N ")) now = Number(line.slice(2)) * 1000;
      else if (line.startsWith("P ")) { const [, pid, et] = line.split(" "); started.set(Number(pid), now - seconds(et) * 1000); }
      else if (line.startsWith("R ") && line.includes('"session_meta"')) {
        const id = line.match(/"payload":\{.*?"id":"([^"]+)"/)?.[1];
        const ts = line.match(/"payload":\{.*?"timestamp":"([^"]+)"/)?.[1];
        const cwd = line.match(/"payload":\{.*?"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
        const src = line.match(/"thread_source":"([^"]+)"/)?.[1];
        if (id && ts && cwd && (!src || src === "user")) sessions.push({ id, at: Date.parse(ts), cwd: JSON.parse(`"${cwd}"`) });
      }
    }
    sessions.sort((a, b) => b.at - a.at);
    const taken = new Set();
    // Newest process first, so an older one in the same folder can't take a newer one's session.
    const procs = terms.map((t) => ({ t, at: started.get(t.foreground.pid) })).filter((p) => p.at).sort((a, b) => b.at - a.at);
    const cwdOf = (t) => t.foreground.cwd ?? t.cwd;
    const inCwd = new Map();
    for (const { t } of procs) inCwd.set(cwdOf(t), (inCwd.get(cwdOf(t)) ?? 0) + 1);
    // Sessions live processes already have: nobody else takes them.
    const held = new Map();
    for (const { t } of procs) { const e = this.byKey.get(keyOf(t)); if (e) held.set(e.sid, keyOf(t)); }
    for (const { t, at } of procs) {
      const cwd = cwdOf(t);
      const k = keyOf(t);
      const cur = this.byKey.get(k);
      const s = sessions.find((x) => !taken.has(x.id) && (!held.has(x.id) || held.get(x.id) === k) && x.cwd === cwd && x.at >= at - SLACK_MS);
      // A process with a session moves to a newer one (after /new) only when it's the only Codex agent in
      // that folder.
      const move = s && (!cur || s.id === cur.sid || inCwd.get(cwd) === 1);
      const argv = t.foreground.argv ?? [];
      const resumed = argv[1] === "resume" && argv[2] && !argv[2].startsWith("-") ? argv[2] : null;
      const sid = (move ? s.id : cur?.sid) ?? resumed;
      if (sid) taken.add(sid);
      if (sid) this.byKey.set(keyOf(t), { sid, cwd });
    }
  }
}
