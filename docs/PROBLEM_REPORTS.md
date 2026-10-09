# Problem reports and automatic fixes

When PDFlip meets something it cannot handle, it tells the user and offers a one-tap report. Reports become GitHub
issues, and a scheduled Claude routine turns each new issue into a pull request with a proposed fix and an urgency
rating. The maintainer only reviews and merges (or closes) the pull request.

```
user's browser ──(tap "Send report")──▶ relay (Cloudflare Worker) ──▶ GitHub issue  [auto-report]
                                                                            │
                                    scheduled Claude routine (daily) ◀──────┘
                                                │
                              branch claude/fix-issue-<n> ──▶ pull request "Fix #<n>: …"
                                                                     │
                                                    maintainer reviews, merges or closes
```

## What is detected

| Kind | When | Where |
|---|---|---|
| `missing-character-map` | pdf.js asks for a character map (CMap) PDFlip does not ship, so Chinese/Japanese/Korean text in a PDF without embedded fonts goes missing | `openPdf` in `src/lib/pdfToCards.ts` |
| `pdf-reader-warning` | pdf.js gives up on part of a PDF (an image, a font, a feature) and logs a warning | `src/lib/pdfWorker.ts` forwards the worker's warnings |
| `unsupported-characters` | card text has characters no bundled font can draw (shown as "?") | `FontBook` in `src/lib/fonts.ts` |
| `unreadable-part` | the Goodnotes reader skips a part it does not understand (pen type, element kind, image format, card side) | `skip()` in `src/lib/goodnotes/read.ts` |
| `unexpected-error` | any exception that is not one of PDFlip's own "wrong file" messages | the two tool components |

PDFlip does not interpret what it cannot handle: it never decides which language or script a problem is about. The
message to the user stays generic, and the report carries the raw facts (character map names, code points, warning
text, structure fingerprints, error messages) for whoever handles the issue. New cases in these categories need no
new code. Problems that go wrong **silently** need a check where the information is lost; a fix for
such a problem should add one (see the fixer's rules below).

## What a report contains

Only technical details, shown to the user before sending: kind, area, a stable signature, character map names,
Unicode code points (up to five) and their 4096-character blocks, pdf.js warnings (numbers removed), structural fingerprints of unreadable
parts (field numbers, type signature, first bytes), error messages and stack lines, the PDFlip commit and a browser
summary like "Safari 18 on iPad". Never the file, its images or card text. Issues are public.

## The relay (`relay/`)

A Cloudflare Worker (free plan: 100,000 requests a day, no credit card). It

- accepts reports only from the PDFlip website (`ALLOWED_ORIGINS`),
- validates them strictly (known fields only, short plain text, no markup, mentions or code fences),
- allows 10 reports per device per hour and 10 new issues per hour,
- de-duplicates by signature: a known problem gets at most one "reported again" comment per 6 hours, and a problem
  whose issue was closed in the last 14 days is not opened again,
- creates the issue with labels `auto-report`, `area:…`, `kind:…`.

Tests: `npx vitest run relay`. Type check: `npx tsc --noEmit -p relay`.

### Setting it up (once, about 10 minutes)

1. **GitHub token.** github.com → Settings → Developer settings → Personal access tokens → *Fine-grained tokens* →
   *Generate new token*:
   - Repository access: *Only select repositories* → `pdflip`
   - Permissions → Repository permissions → **Issues: Read and write** (nothing else)
   - Expiration: up to a year; renew it before it runs out (reports fail with "Could not create the report").
2. **Deploy the worker** (needs Node.js 22), in a terminal:
   ```
   cd pdflip/relay
   npx wrangler login                     # opens Cloudflare in the browser
   npx wrangler secret put GITHUB_TOKEN   # paste the token from step 1
   npx wrangler deploy
   ```
   Wrangler prints the address, e.g. `https://pdflip-reports.<account>.workers.dev`.
3. **Connect the site.** Put that address into `reportUrl` in `src/site.config.ts` and merge. Until then the report
   button opens a pre-filled GitHub issue page instead (which needs a GitHub account).

## The fixer routine

A scheduled Claude Code routine (daily) works through open `auto-report` issues that have no `fix-proposed` or
`needs-human` label, at most three per run. Its instructions:

1. Rate the urgency: **Critical** (crash or data loss with common files, or a security problem), **High** (common
   content missing, e.g. a whole language, or many reports), **Medium** (a specific kind of content missing), **Low**
   (rare or cosmetic).
2. Branch `claude/fix-issue-<n>` from the latest `main`.
3. Reproduce with a failing test built from the report's details (a minimal synthetic PDF or deck); the user's file is
   never available.
4. Fix it with the smallest change that follows the code's style. If the problem was silent, add a check so it is
   reported in future. Mind the size of new assets: everything in `dist/` is cached for offline use.
5. `npm run typecheck`, `npm test` and `npm run build` must pass.
6. Commit and open a pull request "Fix #<n>: …" whose commit message and description state the urgency with reasons,
   what the problem is about, the root cause, the fix, the tests and the risk, ending with "Closes #<n>". Never merge.
7. Label the issue `fix-proposed` and link the pull request in a comment. If a fix is not possible from the report
   alone (e.g. a sample file is needed), explain why on the issue and label it `needs-human` instead.
