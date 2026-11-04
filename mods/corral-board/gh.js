// Where GitHub PRs stand (open, draft, merged, closed), asked of the `gh` CLI on this computer with its own
// login: one GraphQL call for every github.com PR on the board. Without `gh`, or logged out, or for a PR
// this login can't see, nothing is known and the chips look as they always did.
import { exec } from "herdr";

const GH = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const EVERY_MS = 300000; // a PR's state changes on someone's click: every 5 minutes is soon enough
// An app started from the Dock may not have Homebrew on its PATH.
const BINS = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

export class GhPrs {
  constructor() {
    this.state = new Map(); // url → "open" | "draft" | "merged" | "closed"
    this.asked = new Map(); // url → when last asked (ms)
    this.bin = undefined; // the gh that ran; null: none did
  }

  of(url) {
    return this.state.get(url) ?? null;
  }

  // Asks for the PRs never asked about or asked about over 5 minutes ago. True if anything changed.
  async refresh(urls) {
    if (this.bin === null) return false;
    const now = Date.now();
    const due = [...new Set(urls)].filter((u) => GH.test(u) && now - (this.asked.get(u) ?? 0) >= EVERY_MS).slice(0, 50);
    if (!due.length) return false;
    for (const u of due) this.asked.set(u, now);
    const query = `query{${due.map((u, i) => `p${i}:resource(url:${JSON.stringify(u)}){...on PullRequest{state isDraft}}`).join(" ")}}`;
    let r = null;
    for (const bin of this.bin ? [this.bin] : BINS) {
      try { r = await exec(bin, ["api", "graphql", "-f", `query=${query}`]); } catch { continue; }
      this.bin = bin;
      break;
    }
    if (!r) { this.bin = null; return false; }
    // A PR this login can't see fails its own part only: the rest still come back, with the errors beside them.
    let data;
    try { data = JSON.parse(r.stdout).data; } catch { return false; }
    let changed = false;
    due.forEach((u, i) => {
      const p = data?.[`p${i}`];
      const s = !p?.state ? null : p.state === "OPEN" && p.isDraft ? "draft" : p.state.toLowerCase();
      if (s && this.state.get(u) !== s) { this.state.set(u, s); changed = true; }
    });
    return changed;
  }
}
