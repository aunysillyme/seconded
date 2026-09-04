/* SECONDED - the room worker.

   One Durable Object per room, addressed by name. The rule that matters lives
   here, not in the page: a flag is stored against a reviewer token and a line,
   and the view handed out never carries the token. A line's flag TEXT leaves
   the room only when two different tokens flagged that line. A lone flag is a
   count, never a sentence, and that never changes - not for the owner either.

   Everyone who seals must flag at least MIN_FLAGS lines, so having flagged at
   all identifies nobody. There is no cap on reviewers. Each reviewer is its own
   storage key, so a big room never outgrows a single value.

   Known limit, stated on purpose: a determined person with two browsers can
   second themselves. The promise is against the owner and the rest of the
   group reading the room, not against an adversary with a second device. */

const THRESHOLD = 2;      // independent flags needed to unseal a line
const MIN_FLAGS = 2;      // lines each reviewer must flag before sealing
const MIN_SEALED_TO_REVEAL = 2; // with one sealed, the owner would know whose lines those are
const MAX_LINES = 60;
const MAX_LINE = 300;
const MAX_WHY = 240;
const MAX_ANSWER = 400;
const MAX_BODY = 32 * 1024;
const MAX_JOINS_PER_IP = 25; // humans, unlimited; one machine filling a room, not
const CHOICES = new Set(["fix", "accept", "stop"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-token",
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
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  const r = (s, i) => s[b[i] % s.length];
  return r(L, 0) + r(L, 1) + r(L, 2) + r(D, 3) + r(D, 4) + r(D, 5);
};
const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
async function ipHash(req) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("seconded|" + ip));
  return [...new Uint8Array(d).slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean);
    if (p[0] !== "room") return json({ error: "Not found." }, 404);
    const len = Number(req.headers.get("content-length") || 0);
    if (req.method === "POST" && len > MAX_BODY) return json({ error: "Too large." }, 413);

    if (p[1] === "new" && p.length === 2 && req.method === "POST") {
      // The room itself validates the plan. A code that is already taken is
      // retried; /room/<code>/new is not a public path.
      const body = await req.text();
      if (body.length > MAX_BODY) return json({ error: "Too large." }, 413);
      for (let i = 0; i < 4; i++) {
        const code = codeFor();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch(new Request("https://room/" + code + "/new", { method: "POST", body, headers: { "content-type": "application/json" } }));
        if (res.status !== 409) return res;
      }
      return json({ error: "Could not find a free room code. Try again." }, 503);
    }
    const code = cleanCode(p[1]);
    const action = p[2] || "state";
    if (!code || action === "new") return json({ error: "Not found." }, 404);
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const h = new Headers(req.headers);
    h.set("x-ip", await ipHash(req));
    return stub.fetch(
      new Request("https://room/" + code + "/" + action + url.search, {
        method: req.method,
        body: req.method === "POST" ? req.body : undefined,
        headers: h,
      })
    );
  },
};

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = null;          // room record
    this.r = new Map();     // token -> { sealed, flags: [{line, why}] }, one storage key each
    this.ctx.blockConcurrencyWhile(async () => {
      this.s = (await this.ctx.storage.get("s")) || null;
      if (this.s) this.r = await this.ctx.storage.list({ prefix: "r:" }).then((m) => new Map([...m].map(([k, v]) => [k.slice(2), v])));
    });
  }
  async save() { await this.ctx.storage.put("s", this.s); }
  async saveReviewer(t) { await this.ctx.storage.put("r:" + t, this.r.get(t)); }

  async fetch(req) {
    const url = new URL(req.url);
    const [code, action] = url.pathname.split("/").filter(Boolean);
    let body = {};
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > MAX_BODY) return json({ error: "Too large." }, 413);
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: "Bad JSON." }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Bad body." }, 400);
    }

    if (action === "new") {
      if (this.s) return json({ error: "Room code taken." }, 409);
      const raw = String(body.plan || "");
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES).map((l) => l.slice(0, MAX_LINE));
      if (lines.length < 3) return json({ error: "A plan needs at least three lines. One line per plan line." }, 400);
      const title = String(body.title || "").trim().slice(0, 120) || lines[0];
      this.s = { code, title, lines, owner: token(), created: Date.now(), phase: "review", answers: {}, ips: {} };
      await this.save();
      return json({ code, owner: this.s.owner });
    }

    if (!this.s) return json({ error: "No such room." }, 404);
    const s = this.s;
    const t = String(body.token || req.headers.get("x-token") || url.searchParams.get("t") || "");
    const isOwner = !!t && t === s.owner;

    if (action === "join" && req.method === "POST") {
      if (s.phase !== "review") return json({ error: "Review is closed." }, 409);
      if (isOwner) return json({ error: "You wrote it. You do not flag it." }, 409);
      s.ips = s.ips || {};
      const ip = req.headers.get("x-ip") || "?";
      if ((s.ips[ip] || 0) >= MAX_JOINS_PER_IP) return json({ error: "Too many reviewers from one place." }, 429);
      s.ips[ip] = (s.ips[ip] || 0) + 1;
      const tok = token();
      this.r.set(tok, { sealed: false, flags: [] });
      await Promise.all([this.saveReviewer(tok), this.save()]);
      return json({ token: tok });
    }

    if (action === "seal" && req.method === "POST") {
      if (s.phase !== "review") return json({ error: "Review is closed." }, 409);
      const me = this.r.get(t);
      if (!me) return json({ error: "Join the room first." }, 403);
      if (me.sealed) return json({ error: "You already sealed." }, 409);
      const raw = Array.isArray(body.flags) ? body.flags.slice(0, MAX_LINES) : [];
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
      me.flags = flags; me.sealed = true;
      await this.saveReviewer(t);
      return json({ ok: true, sealed: this.sealedCount() });
    }

    if (action === "reveal" && req.method === "POST") {
      if (!isOwner) return json({ error: "Owner only." }, 403);
      if (s.phase === "review") {
        if (this.sealedCount() < MIN_SEALED_TO_REVEAL) return json({ error: `Needs ${MIN_SEALED_TO_REVEAL} sealed before it can be revealed. One sealed would tell you whose lines they are.` }, 409);
        s.phase = "reveal"; await this.save();
      }
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

    if (action === "state" && req.method === "GET") return json(this.view(t));
    return json({ error: "Not found." }, 404);
  }

  sealedCount() { let n = 0; for (const r of this.r.values()) if (r.sealed) n++; return n; }
  counts() {
    const c = new Array(this.s.lines.length).fill(0);
    for (const r of this.r.values()) if (r.sealed) for (const f of r.flags) c[f.line]++;
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
    const me = this.r.get(t);
    const out = {
      code: s.code, title: s.title, lines: s.lines, phase: s.phase,
      threshold: THRESHOLD, minFlags: Math.min(MIN_FLAGS, s.lines.length), minSealed: MIN_SEALED_TO_REVEAL,
      reviewers: this.r.size, sealed: this.sealedCount(),
      you: { owner: !!t && t === s.owner, joined: !!me, sealed: !!(me && me.sealed) },
    };
    if (s.phase === "reveal") {
      const counts = this.counts();
      const whys = s.lines.map(() => []);
      for (const r of this.r.values()) if (r.sealed) for (const f of r.flags) if (f.why) whys[f.line].push(f.why);
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
