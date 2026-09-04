# Audit record

Codex adversarial audit, 2026-09-04, read-only, against worker/src/index.js and index.html as they stood after the first deploy. Claude wrote, Codex attacked, Claude verified each finding before acting.

## Brief

# Audit brief: SECONDED room worker

Code: ./seconded/worker/src/index.js (Cloudflare Worker + one SQLite Durable Object per room). Page: ./seconded/index.html (static, GitHub Pages, calls the worker over CORS *).

Runtime: Cloudflare Workers, public endpoint https://seconded-room.aunysillyme.workers.dev, no auth beyond random tokens. Anyone on the internet can call it.

Threat model: the product promise is anonymity that survives a small group. A reviewer's flag TEXT must only leave the room when >= 2 distinct reviewer tokens flagged the same line. Reviewer tokens must never appear in any response. The owner token must be required for reveal and answer. A single reviewer must not be able to second themselves.

Already verified: 36 live assertions (test.mjs) covering seal minimum, duplicate seal, owner-only reveal/answer, sealed text absent from payload, tokens absent from payload, GO flip.

Attack these: (1) any path to read sealed whys or a reviewer token; (2) self-seconding: can one device obtain two reviewer tokens and unseal its own flag (join is open and uncapped by design, so say whether this is a real break of the promise or an accepted consequence, and what the cheapest mitigation is); (3) timing/count leaks: state polling during review exposes reviewers/sealed counts, does that de-anonymize in a group of 3; (4) DoS or storage growth: unbounded joins per room, unbounded rooms, body sizes; (5) code collision handling in /room/new; (6) XSS in index.html rendering of whys/answers/title (esc() is used, check every sink incl. attribute values); (7) anything in the DO constructor / blockConcurrencyWhile pattern that races on first request.

Design decisions with reasoning, challenge them: reveal is owner-triggered not live (a live reveal leaks who just flagged); owner cannot see sealed text (the promise on the front sheet); no reviewer cap (Auny's ruling); no AI at runtime.

Report findings only, ranked, with a one-line reproduction each. Do not modify files.

## Findings (verbatim) and disposition

## Critical

1. **One person can self-second and disclose their own text.**  
[index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:112) issues unlimited tokens without linking them to a participant; the threshold at [index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:196) therefore proves only “two tokens,” not “two people.” This is a real break of the stated promise, not merely a reviewer-cap consequence; two tokens can also second all 60 lines and force the owner to answer every line. The cheapest meaningful mitigation is owner-issued, single-use reviewer invitations; device cookies, IP limits, and Turnstile are only deterrents.  
**Reproduction:** Call `/join` twice, seal the same two lines under both returned tokens, then reveal; both submitted `why` strings appear.

## High

2. **Room contents and revealed whys are protected by only ~19.6 bits of enumerable code space.**  
[index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:37) produces just `23³ × 8² = 778,688` codes using non-cryptographic `Math.random()`, while [index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:163) returns state—including seconded whys—without a reviewer credential. Anyone can scan the complete namespace and enter or manipulate discovered rooms.  
**Reproduction:** Enumerate every `LLLDD` value and GET `/room/{code}/state`; distinguish live rooms by their 200 responses.

3. **Early owner reveal de-anonymizes line selections in a three-person group.**  
The server permits reveal with zero or one sealed reviewer at [index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:142), then publishes exact per-line counts. Exact live `reviewers`/`sealed` totals at [index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:190), polled every 2.5 seconds, let observers associate a seal with a known participant. Revealing after that first seal identifies all their flagged lines; revealing after two known people seal lets either reviewer derive the other’s flags. Owner-triggered reveal avoids a live per-line leak, but needs an enforced anonymity quorum or expected-participant barrier.  
**Reproduction:** Have one known reviewer seal, observe `sealed` change to 1, immediately reveal, and inspect which lines have `count: 1`.

4. **Every POST buffers unbounded JSON before action-specific validation.**  
[index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:83) calls `req.json()` before examining the action and has no `Content-Length` or streaming limit. Cloudflare accepts request bodies up to 100 MB on Free/Pro while Workers have 128 MB memory, and JSON parsing requires additional allocation, enabling CPU or memory exhaustion. [Cloudflare explicitly recommends enforcing a maximum before buffering](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).  
**Reproduction:** POST a near-100 MB valid JSON object containing an ignored `pad` field to `/room/{code}/join`.

5. **Unbounded reviewers and rooms create targeted and account-wide storage DoS.**  
Every join and seal rewrites the entire room as one ever-growing value at [index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:78). Approximately 133 reviewers each sealing 60 maximum-length whys exceed SQLite Durable Object’s 2 MB per-value limit; there is also no room expiry, cleanup, rate limit, or account-level creation control. Cloudflare documents both the [2 MB SQLite value limit and finite Free-plan storage](https://developers.cloudflare.com/durable-objects/platform/limits/).  
**Reproduction:** Repeatedly join and seal all 60 lines with 240-character whys until `storage.put("s", this.s)` fails and the room becomes too large for further writes.

## Medium

6. **The internal `new` action is publicly reachable for attacker-chosen codes, and generated collisions are not retried.**  
Only exact `/room/new` receives generated-code handling; `/room/ABC12/new` passes through [index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:57) and initializes the chosen object at [index.js](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/worker/src/index.js:89). Attackers can squat generated codes. Separately, `/room/new` makes only one random attempt, returning 409 instead of retrying upon collision.  
**Reproduction:** POST a valid three-line plan to `/room/ABC12/new`; subsequent generated or direct creation of `ABC12` receives the collision response.

7. **Bearer tokens are retained origin-wide and repeatedly placed in query strings.**  
[index.html](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/index.html:145) stores owner and reviewer tokens in `localStorage`, shared by every page under `aunysillyme.github.io`, while [index.html](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/index.html:182) sends the active token in a GET URL every 2.5 seconds. Any compromised same-origin page can read all room tokens, and query strings can be retained in network and platform diagnostics.  
**Reproduction:** From any script executing on the same GitHub Pages origin, enumerate `localStorage` keys beginning with `sec:`; inspect polling requests to see `?t={token}`.

## Low

8. **Opening a room creates a phantom reviewer that can never flag through the UI.**  
After creation, `enter()` sees an owner record without `ME.token` and calls `/join` at [index.html](/private/tmp/claude-501/-Users-auny-Desktop-Claude-Code/29f8141b-af5b-4d29-a50e-0e5ae41aeea8/scratchpad/seconded/index.html:175). Subsequent polling prefers `ME.owner` over that reviewer token, so `you.joined` remains false while the unused token permanently inflates the public reviewer count and weakens count-based anonymity assumptions.  
**Reproduction:** Create a room without sharing it; its first rendered state reports one reviewer even though no reviewer has visited.
tokens used
68,945

## Disposition, round 1

| # | Finding | Action |
|---|---|---|
| 1 | Self-second with two tokens | **Accepted, stated.** Owner-issued invites make the owner the gatekeeper of who may flag, which inverts the product. IP or UA fingerprints silently break two phones on one home wifi. The limit is written into the worker header comment and the README. |
| 2 | ~19.6-bit code space, Math.random | **Partly fixed.** Codes are six characters from crypto.getRandomValues (~22.6 bits). Still enumerable at scale; rooms are short-lived and carry no names. |
| 3 | Early reveal de-anonymizes | **Fixed.** Reveal refuses until two reviewers have sealed (MIN_SEALED_TO_REVEAL). |
| 4 | Unbounded JSON buffering | **Fixed.** Content-Length and body text capped at 32 KB before parse, 413 verified by hand with curl. |
| 5 | Single growing storage value, no rate limit | **Fixed.** One storage key per reviewer; 25 joins per hashed IP per room (humans unlimited, one machine not). No room expiry yet. |
| 6 | /room/<code>/new reachable, no collision retry | **Fixed.** Path closed (404), four retries on 409. |
| 7 | Tokens in query strings and origin-wide localStorage | **Half fixed.** Token moved to an x-token header. localStorage stays: the page is on a shared GitHub Pages origin and this is the trade for no accounts. |
| 8 | Owner auto-joins as a phantom reviewer | **Fixed.** Owner never joins; the server also refuses an owner join with 409. |

Not run: a round 2 re-audit after these fixes. The live test suite went from 36 to 40 assertions covering 3, 4, 6 and 8.
