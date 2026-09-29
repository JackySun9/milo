# bc-agent — Brand Concierge conversation tester

Drives the Brand Concierge (BC) chat the way a person would, then writes an HTML report with the full transcript, a screenshot per turn, and pass/warn/fail checks.

BC replies come from an AI, so the exact wording changes from run to run. The checks look at **which widget or workflow rendered** instead: product card, citations, table, Firefly gallery, image generation, meeting form, calendar, advisor handoff, SUSI sign-in, or a friendly error. They do not compare exact text.

This tool is self-contained (its own `package.json`/`package-lock.json`, independent of the Milo root install) so it can be `npm ci`'d on its own in CI. It is invoked from `.github/workflows/brand-concierge-agent.yml`, which runs the standard business-stage workflow below on the same self-hosted Mac mini pool as screenshot-diff, publishes the run to S3 (see "Publishing to S3") and also uploads `reports/run/` as the GitHub Actions artifact `bc-agent-<run_id>`. The only secrets used are the Screenshot Diff S3 keys.

## Setup

```bash
cd tools/bc-agent
npm install          # playwright 1.58 (uses the cached Chromium)
npm test             # unit tests for the reply classifier / explorer (no browser)
```

## Run

```bash
# All automated test-plan scenarios against a page
node run.mjs --url https://business.stage.adobe.com/

# Selected scenarios, visible browser
node run.mjs --url https://main--milo--adobecom.aem.page/drafts/nala/blocks/brand-concierge/brand-concierge --only M3,M4 --headed

# Explorer only: seed prompts, then follow suggested prompts / CTAs
node run.mjs --url https://business.stage.adobe.com/ --explore --no-scenarios --depth 4
node run.mjs --explore --no-scenarios --seeds "I need a CMS for 40 sites|Generate a logo for a bakery"
```

The report is written to `reports/<host>-<timestamp>/report.html`, next to `report.json` and the screenshots. The process exits with code 1 if any scenario fails or errors.

## Shareable standard workflow: business stage

Use the standard workflow when the goal is a repeatable health check rather
than investigating one test case:

```bash
cd bc-agent
npm install
npm run workflow:business-stage
```

It defaults to `https://business.stage.adobe.com/?milolibs=stage`, uses the
eight shared opening prompts, follows suggestions for up to four turns and
writes:

- `workflow-summary.md` — short, shareable conclusion and PASS/REVIEW checks
- `workflow-summary.json` — the same result for automation
- `report.html` / `report.json` — full transcripts, workflow coverage and screenshots

The standard reflects the current confirmed product behavior:

- recommending Firefly for photo editing is valid;
- sales intent may go directly to Schedule meeting and the contact form;
- after two free image generations, Firefly Gallery + Sign in is valid;
- a live-advisor handoff and a Photoshop/Lightroom recommendation are not
  required for this health check.

Pass any Brand Concierge page directly (including a branch build):

```bash
npm run workflow:business-stage -- \
  --url 'https://business.stage.adobe.com/?milolibs=my-branch'
```

`PASS` means the recommendation, citations, comparison table, meeting flow,
image generation or quota gate, and feedback controls were all observed.
`REVIEW` means one was not observed; inspect the transcript and retry any
timed-out path before filing a defect. To use another stage build or output
directory:

```bash
npm run workflow:business-stage -- \
  --url 'https://main--milo--adobecom.aem.page/drafts/nala/blocks/brand-concierge/brand-concierge' \
  --out 'reports/my-check'
```

`BC_WORKFLOW_URL` and `BC_WORKFLOW_OUT` remain available for CI or scheduled
runs; command-line values take precedence. `BC_RUN_ID` / `BC_RUN_URL` are
copied into `workflow-summary.json` when set.

Each check in `workflow-summary.json` has `pass`, `status` (`pass` / `review`,
or `error` when the agent crashed before writing a report) and one evidence
`screenshot` (a file name next to the summary). `evidence` is `observed` when
the screenshot shows the widget that proves the check, `fallback` when it is
the last turn of the seed path meant to reach it, `error-state` when that
path failed before any turn (a screenshot of the page when it failed), or
`none`. Explorer paths that error or capture no turns are retried once,
sequentially, after the parallel pass; the retry replaces the path only if it
captured turns (`retried`, `firstError`/`retryError` record what happened).

### Publishing to S3

CI publishes each run to the Screenshot Diff bucket (`milo` on
`s3-sj3.corp.adobe.com`) with `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`:

```bash
node publish-s3.mjs --dir reports/run --run-id 12345 --url <tested url> --run-url <GitHub run url>
```

| Key | Content |
|---|---|
| `screenshots/bc-agent/runs/<runId>/workflow-summary.json` / `.md` | Status and checks |
| `screenshots/bc-agent/runs/<runId>/report.html` / `report.json` | Full transcript |
| `screenshots/bc-agent/runs/<runId>/<shot>.png` | Every screenshot the report or summary references |
| `screenshots/bc-agent/runs/index.json` | `[{ runId, status, passed, total, url, startedAt, publishedAt, runUrl, prefix, summary, report }]`, newest first, 50 max |
| `screenshots/bc-agent/latest.json` | The newest index entry |

nala-auto reads them through `http://nala-auto.corp.adobe.com/api/milo/<key>`.
Only plain `*.png` names inside the run directory are uploaded (no `..`, `/` or
symlinks out of it). The index and `latest.json` are written last and only when
the summary was uploaded. If the agent crashed, an `error` summary is published.

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `https://business.stage.adobe.com/` | Page containing BC (marquee, floating button, or gnav entry) |
| `--only` | all | Comma-separated scenario ids |
| `--explore` / `--no-scenarios` | off / off | Run the explorer, or skip scenarios |
| `--seeds` | built-in list | `|`-separated opening prompts for the explorer |
| `--depth` | 3 | Turns per explorer path |
| `--persona` | off | Let an LLM write the explorer's next message (see below) |
| `--submit-forms` | off | M4: fill and submit the meeting form with test data to reach the calendar. **Refused on non-stage hosts** (it would create a real lead) |
| `--parallel` | 3 | Concurrent browser contexts |
| `--timeout` | 90 | Seconds to wait for each reply |
| `--repeat` | 1 | Run each scenario N times and report a pass rate. AI routing varies, e.g. M1 sometimes recommends Firefly instead of Photoshop |

## Scenarios (wiki "BC — Test Plan", manual section)

| id | Automated checks |
|---|---|
| M1 | Photo prompt → Photoshop/Lightroom mentioned, Sources, feedback icons, product links return < 400 |
| M2 | Firefly gallery widget; on stage, no production links |
| M3 | Sales request, then a follow-up (and the "talk to a sales agent" suggestion if needed) → advisor mode, placeholder, End connection → back to AI |
| M4 | Answers clarifying questions and clicks Schedule meeting → form, subtitle, 2-per-row / 1-per-row layout, submit label. With `--submit-forms`: calendar |
| M5 | Logged out: image generation → Sign in → SUSI modal title, providers, stage identity host, Close keeps the chat and its history |
| M7 | Compare prompt → table, both products covered, fits or scrolls |
| M8 | Sources, inline citation numbers, `target=_blank`, citation links < 400 |
| M10 | At 1920px wide, `.input-container` ≤ 800px and centred |
| M12 | Conversation request aborted → friendly error; retry without reload works |
| M13 | Thumbs up/down dialogs, Cancel, Other + Submit → toast |

These stay manual and are listed in the report: M5b (successful login), M6 (cross-page persistence, partly covered by milo `brand-concierge.test.js`), M9 (on-screen keyboard) and M11 (device rotation).

## Explorer

The explorer opens each seed prompt in a fresh session, then keeps clicking suggestion chips and action buttons it hasn't tried yet. It tries meeting and sales moves first, and never clicks links that leave the page or Sign in. It stops when it reaches the meeting form, unless `--submit-forms` is set. The report lists every workflow reached and the path that reached it first.

With `--persona` it uses an LLM to play a curious business visitor who picks the next message or button. The endpoint must be OpenAI-compatible:

```
BC_AGENT_API_KEY   (falls back to AI_JUDGE_API_KEY)
BC_AGENT_BASE_URL  (falls back to AI_JUDGE_BASE_URL, default https://api.openai.com/v1)
BC_AGENT_MODEL     (falls back to AI_JUDGE_MODEL,   default gpt-4o-mini)
```

## Notes

- Every scenario and explorer path uses a fresh browser context. A persisted chat history disables the marquee input.
- Free Firefly image generations run out after two images. After that, "generate an image" returns the Firefly community gallery with a Sign in button. M5 accepts either reply.
- Escape on the SUSI modal closes the whole chat, so M5 cancels with the modal's Close button.
