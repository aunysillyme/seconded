// Live test against the deployed worker. node test.mjs [base]
const BASE = process.argv[2] || "https://seconded-room.aunysillyme.workers.dev";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("FAIL", m); } };
const post = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return [r.status, await r.json()]; };
const get = async (p, tok) => (await fetch(BASE + p, { headers: tok ? { "x-token": tok } : {} })).json();

// plan validation
let [st, r] = await post("/room/new", { plan: "one\ntwo" });
ok(st === 400, "two-line plan rejected");
[st, r] = await post("/room/new", { title: "Offsite", plan: "Drive up Friday at 3\nOne cabin sleeps 12\n6am hike then 9 to 5 session\nBudget $4800 split evenly\nAlcohol on company card\nPriya books Monday" });
ok(st === 200 && r.code && r.code.length === 6 && r.owner, "room created, six-char code");
[st] = await post(`/room/${r.code}/new`, { plan: "a\nb\nc" });
ok(st === 404, "/room/<code>/new is not a public path");
[st] = await post(`/room/${r.code}/join`, { token: r.owner });
ok(st === 409, "owner cannot join as a reviewer");
const code = r.code, owner = r.owner;

// three reviewers, no cap: add a fourth and fifth too
const toks = [];
for (let i = 0; i < 5; i++) { const [s2, j] = await post(`/room/${code}/join`, {}); ok(s2 === 200 && j.token, "join " + i); toks.push(j.token); }
let v = await get(`/room/${code}/state`, toks[0]);
ok(v.reviewers === 5 && v.phase === "review" && v.you.joined && !v.you.owner, "state before seal");
ok(v.reveal === undefined, "no reveal data during review");

// too few flags
[st, r] = await post(`/room/${code}/seal`, { token: toks[0], flags: [{ line: 2, why: "6am hike is cruel" }] });
ok(st === 400, "one flag rejected (minimum two)");
// unknown token
[st, r] = await post(`/room/${code}/seal`, { token: "nope", flags: [{ line: 0 }, { line: 1 }] });
ok(st === 403, "unknown token cannot seal");
// duplicate line collapses
[st, r] = await post(`/room/${code}/seal`, { token: toks[0], flags: [{ line: 2, why: "6am hike before 8h session" }, { line: 2, why: "dup" }, { line: 4, why: "card policy says no alcohol" }] });
ok(st === 200, "seal 0 with two distinct lines");
[st, r] = await post(`/room/${code}/seal`, { token: toks[0], flags: [{ line: 0 }, { line: 1 }] });
ok(st === 409, "cannot seal twice");
[st] = await post(`/room/${code}/reveal`, { token: owner });
ok(st === 409, "reveal with one sealed is refused (quorum)");
[st] = await post(`/room/${code}/seal`, { token: toks[1], flags: [{ line: 2, why: "not everyone can hike" }, { line: 3, why: "" }] });
ok(st === 200, "seal 1");
[st] = await post(`/room/${code}/seal`, { token: toks[2], flags: [{ line: 4, why: "two people do not drink" }, { line: 5, why: "Priya is out Monday" }] });
ok(st === 200, "seal 2");
// reviewers 3 and 4 never seal; that is allowed

// reveal is owner only
[st] = await post(`/room/${code}/reveal`, { token: toks[0] });
ok(st === 403, "reviewer cannot reveal");
// answer before reveal
[st] = await post(`/room/${code}/answer`, { token: owner, line: 2, choice: "fix", text: "x" });
ok(st === 409, "no answer before reveal");
[st, r] = await post(`/room/${code}/reveal`, { token: owner });
ok(st === 200 && r.phase === "reveal", "owner reveals");
[st] = await post(`/room/${code}/join`, {});
ok(st === 409, "no joining after reveal");

// the seal rule
v = await get(`/room/${code}/state`, owner);
ok(v.you.owner, "owner flagged as owner");
ok(v.flags === 6 && v.secondedCount === 2, `totals: flags ${v.flags} seconded ${v.secondedCount}`);
ok(v.reveal[2].count === 2 && v.reveal[2].seconded && v.reveal[2].whys.length === 2, "line 2 seconded, two whys");
ok(v.reveal[4].count === 2 && v.reveal[4].whys.length === 2, "line 4 seconded");
ok(v.reveal[3].count === 1 && !v.reveal[3].seconded && v.reveal[3].whys.length === 0, "line 3 lone flag: count only");
ok(v.reveal[5].count === 1 && v.reveal[5].whys.length === 0, "line 5 lone flag: why sealed even from owner");
ok(!JSON.stringify(v).includes("Priya is out Monday"), "sealed text never in the payload");
ok(!JSON.stringify(v).includes(toks[0]), "no reviewer token in the payload");
ok(v.go === false && v.answered === 0, "NO GO before answers");

// answers
[st] = await post(`/room/${code}/answer`, { token: toks[0], line: 2, choice: "fix", text: "x" });
ok(st === 403, "reviewer cannot answer");
[st] = await post(`/room/${code}/answer`, { token: owner, line: 3, choice: "fix", text: "x" });
ok(st === 409, "lone-flag line takes no answer");
[st] = await post(`/room/${code}/answer`, { token: owner, line: 2, choice: "maybe", text: "x" });
ok(st === 400, "bad choice rejected");
[st] = await post(`/room/${code}/answer`, { token: owner, line: 2, choice: "fix", text: "" });
ok(st === 400, "empty answer rejected");
[st, r] = await post(`/room/${code}/answer`, { token: owner, line: 2, choice: "fix", text: "Hike moves to Sunday, optional. Session 10 to 3." });
ok(st === 200 && r.go === false, "first answer, still NO GO");
[st, r] = await post(`/room/${code}/answer`, { token: owner, line: 4, choice: "stop", text: "No alcohol on the card. BYO." });
ok(st === 200 && r.go === true, "second answer flips GO");
v = await get(`/room/${code}/state`);
ok(v.go === true && v.reveal[4].answer.choice === "stop", "GO visible to an anonymous reader");

// oversized body
const big = await fetch(BASE + `/room/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(40000) }) });
ok(big.status === 413, "oversized body refused");
// unknown room
const nf = await fetch(BASE + "/room/ZZZ999/state");
ok(nf.status === 404, "unknown room 404");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
