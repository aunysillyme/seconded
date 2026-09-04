/* SECONDED - the room worker.

   One Durable Object per room, addressed by name. The rule that matters lives
   here, not in the page: a flag is stored against a device token and a line,
   and the view handed out never carries the token. A line's flag TEXT leaves
   the room only when two different tokens flagged that line. A lone flag is a
   count, never a sentence, and that never changes - not for the owner either.

   Everyone who seals must flag at least MIN_FLAGS lines, so having flagged at
   all identifies nobody. There is no cap on reviewers. */

const THRESHOLD = 2;      // independent flags needed to unseal a line
const MIN_FLAGS = 2;      // lines each reviewer must flag before sealing
const MAX_LINES = 60;
const MAX_LINE = 300;
const MAX_WHY = 240;
const MAX_ANSWER = 400;
const CHOICES = new Set(["fix", "accept", "stop"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

const token = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const codeFor = () => {
  const L = "ABCDEFGHJKMNPQRSTUVWXYZ", D = "23456789";
  const r = (s) => s[Math.floor(Math.random() * s.length)];
  return r(L) + r(L) + r(L) + r(D) + r(D);
};
const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean);
    if (p[0] !== "room") return json({ error: "Not found." }, 404);

    if (p[1] === "new" && req.method === "POST") {
      // Pick a code the caller has not seen; the room itself validates the plan.
      const code = codeFor();
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(new Request("https://room/" + code + "/new", { method: "POST", body: req.body, headers: req.headers }));
    }
    const code = cleanCode(p[1]);
    if (!code) return json({ error: "No room." }, 400);
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    return stub.fetch(
      new Request("https://room/" + code + "/" + (p[2] || "") + url.search, {
        method: req.method,
        body: req.method === "POST" ? req.body : undefined,
        headers: req.headers,
      })
    );
  },
};

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.s = (await this.ctx.storage.get("s")) || null;
    });
  }
  async save() { await this.ctx.storage.put("s", this.s); }

  async fetch(req) {
    const url = new URL(req.url);
    const [code, action] = url.pathname.split("/").filter(Boolean);
    let body = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
      if (!body || typeof body !== "object") return json({ error: "Bad body." }, 400);
    }

    if (action === "new") {
      if (this.s) return json({ error: "Room code collision, try again." }, 409);
      const raw = String(body.plan || "");
      if (raw.length > MAX_LINES * MAX_LINE) return json({ error: "Plan too long." }, 400);
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES).map((l) => l.slice(0, MAX_LINE));
      if (lines.length < 3) return json({ error: "A plan needs at least three lines. One line per plan line." }, 400);
      const title = String(body.title || "").trim().slice(0, 120) || lines[0];
      this.s = {
        code, title, lines, owner: token(), created: Date.now(),
        phase: "review",                // review -> reveal
        reviewers: {},                  // token -> { sealed: bool }
        flags: {},                      // token -> [{ line, why }]
        answers: {},                    // line -> { choice, text }
      };
      await this.save();
      return json({ code, owner: this.s.owner });
    }

    if (!this.s) return json({ error: "No such room." }, 404);
    const s = this.s;
    const t = String(body.token || url.searchParams.get("t") || "");
    const isOwner = t && t === s.owner;

    if (action === "join" && req.method === "POST") {
      if (s.phase !== "review") return json({ error: "Review is closed." }, 409);
      const tok = token();
      s.reviewers[tok] = { sealed: false };
      await this.save();
      return json({ token: tok });
    }

    if (action === "seal" && req.method === "POST") {
      if (s.phase !== "review") return json({ error: "Review is closed." }, 409);
      const r = s.reviewers[t];
      if (!r) return json({ error: "Join the room first." }, 403);
      if (r.sealed) return json({ error: "You already sealed." }, 409);
      const raw = Array.isArray(body.flags) ? body.flags : [];
      const seen = new Set();
      const flags = [];
      for (const f of raw) {
        const line = Number(f && f.line);
        if (!Number.isInteger(line) || line < 0 || line >= s.lines.length || seen.has(line)) continue;
        seen.add(line);
        flags.push({ line, why: String((f && f.why) || "").trim().slice(0, MAX_WHY) });
      }
      const need = Math.min(MIN_FLAGS, s.lines.length);
      if (flags.length < need) return json({ error: `Flag at least ${need} lines. That is what keeps you anonymous.` }, 400);
      s.flags[t] = flags;
      r.sealed = true;
      await this.save();
      return json({ ok: true, sealed: this.sealedCount() });
    }

    if (action === "reveal" && req.method === "POST") {
      if (!isOwner) return json({ error: "Owner only." }, 403);
      if (s.phase === "review") { s.phase = "reveal"; await this.save(); }
      return json({ ok: true, phase: s.phase });
    }

    if (action === "answer" && req.method === "POST") {
      if (!isOwner) return json({ error: "Owner only." }, 403);
      if (s.phase !== "reveal") return json({ error: "Reveal first." }, 409);
      const line = Number(body.line);
      const choice = String(body.choice || "");
      const text = String(body.text || "").trim().slice(0, MAX_ANSWER);
      if (!Number.isInteger(line) || line < 0 || line >= s.lines.length) return json({ error: "No such line." }, 400);
      if (!CHOICES.has(choice)) return json({ error: "Choice is fix, accept or stop." }, 400);
      if (!text) return json({ error: "Write the answer. The room reads it." }, 400);
      if (this.counts()[line] < THRESHOLD) return json({ error: "Only seconded lines take an answer." }, 409);
      s.answers[line] = { choice, text };
      await this.save();
      return json({ ok: true, go: this.go() });
    }

    if (action === "state" || action === "") {
      return json(this.view(t));
    }
    return json({ error: "Not found." }, 404);
  }

  sealedCount() { return Object.values(this.s.reviewers).filter((r) => r.sealed).length; }
  counts() {
    const c = new Array(this.s.lines.length).fill(0);
    for (const fl of Object.values(this.s.flags)) for (const f of fl) c[f.line]++;
    return c;
  }
  seconded() { return this.counts().map((n, i) => (n >= THRESHOLD ? i : -1)).filter((i) => i >= 0); }
  go() {
    const sec = this.seconded();
    return sec.length > 0 && sec.every((i) => this.s.answers[i]);
  }

  /* The only thing that leaves the room. Same shape for everyone, owner
     included: flag text only on lines with THRESHOLD or more independent
     flags, shuffled so order says nothing about who or when. */
  view(t) {
    const s = this.s;
    const me = s.reviewers[t];
    const out = {
      code: s.code, title: s.title, lines: s.lines, phase: s.phase,
      threshold: THRESHOLD, minFlags: Math.min(MIN_FLAGS, s.lines.length),
      reviewers: Object.keys(s.reviewers).length, sealed: this.sealedCount(),
      you: { owner: t === s.owner, joined: !!me, sealed: !!(me && me.sealed) },
    };
    if (s.phase === "reveal") {
      const counts = this.counts();
      const whys = s.lines.map(() => []);
      for (const fl of Object.values(s.flags)) for (const f of fl) if (f.why) whys[f.line].push(f.why);
      out.reveal = s.lines.map((_, i) => ({
        count: counts[i],
        seconded: counts[i] >= THRESHOLD,
        whys: counts[i] >= THRESHOLD ? shuffle(whys[i]) : [],
        answer: s.answers[i] || null,
      }));
      out.flags = counts.reduce((a, b) => a + b, 0);
      out.secondedCount = this.seconded().length;
      out.answered = Object.keys(s.answers).length;
      out.go = this.go();
    }
    return out;
  }
}

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
