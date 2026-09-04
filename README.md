# SECONDED

**A concern is heard when a second person has it too.**

Camp AI, Season 2 Episode 9, theme "Group Red Flag Detector". Built live in the window.

Live: https://aunysillyme.github.io/seconded/ · Worker: https://seconded-room.aunysillyme.workers.dev

## How it works

1. The owner pastes a plan, one line per plan line, and gets a room code.
2. Reviewers open the link and flag lines, with an optional one-line why. Everyone must flag at least two lines before sealing, so having flagged at all identifies nobody.
3. The owner reveals. A line's flag text unseals only when two independent people flagged it. A lone flag is a count and a black bar, for everyone, owner included, forever.
4. The owner answers every seconded line (fix / accept / stop). The stamp reads NO GO until the last one is answered, then GO.
5. GO lands everyone on the final sheet: the corrected plan as a clean document, fixes in place, stopped lines out, one button to copy it. The marked-up review stays one tap away.

Four sample plans on the share sheet carry intentional mistakes, so a demo room has something to flag in the first ten seconds.

No cap on reviewers. Threshold stays two.

Known limit, on purpose: a determined person with a second browser can second themselves. The promise is against the owner and the rest of the group, not against an adversary with two devices. Owner-issued invites would make the owner the gatekeeper of who may flag, which inverts the product.

## Stack

- `index.html`: one self-contained page. Pleading paper, redaction bars, three colors.
- `worker/`: a Cloudflare Worker with one SQLite Durable Object per room (`idFromName(code)`). No database, no model at runtime. The seal rule lives in the worker, not the page: the view handed out never carries a reviewer token, and sealed text never leaves the room.
- `worker/test.mjs`: 40 assertions against the live worker.
- `AUDIT.md`: the Codex audit brief, its eight findings, and what was done with each.

Runtime cost: $0 (GitHub Pages + Workers free tier).
