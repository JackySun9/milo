# Screenshot Diff Tool — Standardization Proposal

**Status:** PoC complete, awaiting infra approvals
**Owner:** Jacky Sun (xiasun@adobe.com)
**Last updated:** 2026-05-07

## TL;DR

Migrate the screenshot-diff capability from `adobecom/nala` (BACOM-internal,
test-framework-coupled) into `adobecom/milo` as a self-service tool at
`milo.adobe.com/tools/screenshot-diff`. Make it usable by any Adobe team via
a simple URL form, backed by a self-hosted Mac Mini runner pool and our
internal S3 bucket. PoC is complete and validated locally.

## Background

The visual regression code in
[`adobecom/nala/libs/screenshot/`](https://github.com/adobecom/nala/tree/main/libs/screenshot)
works well for BACOM's needs but is:

- **Coupled** to nala's Playwright test harness — you must write spec files
  to use it
- **Not discoverable** outside BACOM
- **Inconsistently configured** — internal-S3 path (`uploads3.js`) and
  public-S3 path (`uploads3Public.js`) coexist; current GitHub workflow
  references env vars that don't match either upload script
- **Hardcoded** to specific S3 endpoints, buckets, and base directories

Other Adobe teams who could benefit from visual regression (CC, DC, Creative
Brand Concierge, etc.) currently can't use it without copying the code.

## Goals

1. **Anyone in Adobe can use it** — open a URL, enter two URLs, get a diff
2. **Internal-only** — internal S3, internal network, IMS-authenticated
3. **Standardized** — one canonical implementation, not per-team forks
4. **Backwards-compatible** — nala continues to work during transition

## Non-Goals (for v1)

- Public/external user access
- Cross-browser concurrent matrix runs in the UI form (use workflow inputs)
- Run history / time-series UI (latest-only for now)
- Automated lifecycle policy on S3 (manual cleanup for now)

## Decisions

### D1. Host = Milo tools, not DA

| | Milo `tools/` | DA tools |
|---|---|---|
| Audience | Engineers / web ops (matches our users) | Content authors |
| Distribution | One PR, one URL works for everyone | Per-project plugin registration |
| Existing convention | `loc/`, `floodbox/`, `graybox/` — direct peers | Build scripts only, no convention |

**Picked Milo.** DA's plugin model requires every consuming team's admin to
register your tool in their config sheet — effectively zero discoverability.

### D2. Storage = Internal S3 only

Drop the public-S3 / STS-assume-role code path. Reasons:

- Adobe employees are the entire target audience
- Internal S3 (`s3-sj3.corp.adobe.com`) is what BACOM already uses
- Eliminating the public path removes ~150 LOC and a dependency
  (`@aws-sdk/client-sts`)

**Constraint introduced:** GitHub-hosted runners can't reach internal S3.
Drives D3.

### D3. Compute = Self-hosted Mac Mini pool

GitHub-hosted runners are public cloud → can't access `*.corp.adobe.com`.
We have three Mac Minis available:

| Host | Suggested runner name |
|---|---|
| `sj1010122072233.corp.adobe.com` | `mac-mini-233` |
| `sj1010122072235.corp.adobe.com` | `mac-mini-235` |
| `sj1010122072236.corp.adobe.com` | `mac-mini-236` |

Bonus over Linux runners: native Webkit / Safari / Mobile-Safari emulation,
matching production user-agents better.

### D4. Form factor = Web tool + GitHub workflow_dispatch

Browser-based UI for "anyone can use," but actual capture runs in CI for
infra reasons (Playwright + browser binaries on a corp-network host). UI
calls GitHub API to trigger `workflow_dispatch`, polls for completion, reads
results from S3.

### D5. Dependency isolation

The tool ships its own `package.json` inside `tools/screenshot-diff/`
instead of adding `@aws-sdk/client-s3` to milo's root deps. Keeps milo's
dependency tree untouched and simplifies the PR.

### D6. Reads via nala-auto, not direct S3

Browser fetches go through
[`nala-auto.corp.adobe.com`](https://github.com/adobecom/nala-auto) which
already proxies the same S3 bucket for the existing BACOM internal viewer.
This avoids needing CORS rules on the S3 endpoint itself — we just need a
~3-line CORS PR to `adobecom/nala-auto`.

Milo's tool **does not duplicate** nala-auto's existing
`/imagediff/:directory` viewer; they coexist:

- **`nala-auto.corp.adobe.com/imagediff/...`** — BACOM internal dashboard
  (current users keep using it)
- **`milo.adobe.com/tools/screenshot-diff/`** — public-facing entry point
  for cross-team self-service ("anyone can compare two URLs")

Both read the same S3 schema.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Milo tool UI                                    │
│  milo.adobe.com/tools/screenshot-diff/           │
│  - Form: URL A, URL B, viewport, project         │
│  - Triggers workflow via GitHub API              │
│  - Renders diff images                           │
└──────────────────────────────────────────────────┘
            ↓ trigger              ↑ fetch (CORS)
            │                      │
            │      ┌───────────────┴──────────────┐
            │      │  nala-auto.corp.adobe.com    │
            │      │  (existing internal viewer)  │
            │      │  /api/milo/*  → S3 proxy     │
            │      └──────────────────────────────┘
            │                      ↑ S3 GET (corp net)
            ↓                      │
┌──────────────────────────────────────────────────┐
│  GitHub Actions workflow                         │
│  .github/workflows/screenshot-diff.yml           │
│  runs-on: [self-hosted, macOS, screendiff]       │
└──────────────────────────────────────────────────┘
            ↓ executes on
┌──────────────────────────────────────────────────┐
│  Mac Mini pool (3 hosts in SJ corp network)      │
│  Playwright + browsers + Node 20                 │
│  - Capture URL A and URL B                       │
│  - Pixel diff (playwright-core comparator)       │
│  - Upload artifacts to internal S3               │
└──────────────────────────────────────────────────┘
            ↓ S3 PUT (corp network)
┌──────────────────────────────────────────────────┐
│  Internal S3 (Cleversafe / IBM COS)              │
│  s3-sj3.corp.adobe.com/milo/screenshots/         │
│    <project>/                                    │
│      shot-a.png  shot-b.png  shot-diff.png       │
│      results.json   timestamp.json               │
└──────────────────────────────────────────────────┘
```

### Why route reads through nala-auto

The Milo UI runs in users' browsers on `milo.adobe.com`. Internal S3
(`s3-sj3.corp.adobe.com`) needs CORS headers to allow cross-origin fetches
from a public origin. Two paths to solve this:

1. **Configure CORS on S3** — requires S3 admin involvement, slow
2. **Route through `nala-auto.corp.adobe.com/api/milo/*`** — nala-auto is
   already a BACOM-controlled `http-proxy-middleware` server fronting the
   same S3 bucket, so a ~3-line CORS PR to
   [`adobecom/nala-auto`](https://github.com/adobecom/nala-auto) is all we
   need

We pick **option 2**. nala-auto already serves the existing
`/imagediff/:directory` viewer for the BACOM team — Milo simply leverages
the same proxy for its tool UI.

## Status

### Done (PoC complete in `JackySun9/milo` fork on `screenshot-diff-tool` branch)

- ✅ Lib code extracted from nala, parameterised via `lib/config.js`
- ✅ Standalone driver `run.js` (env-var input → S3 output)
- ✅ Tool UI (HTML + JS + CSS)
- ✅ GitHub Actions workflow targeting `[self-hosted, macOS, screendiff]`
- ✅ Mac Mini bootstrap script `setup-runner.sh`
- ✅ README with end-user docs
- ✅ Local smoke test passed:
  ```
  ▶ Capturing A: https://main--milo--adobecom.aem.live/
  ▶ Capturing B: https://main--milo--adobecom.aem.page/
  ▶ Comparing pixels  → Differences found
  ▶ Wrote screenshots/smoke-test/results.json
  ✓ Done. DIFF
  ```
  Diff image visually correct.

**14 files, ~700 LOC, ~0 dependencies added to milo's root.**

### Not done (needs infra / approvals)

- ⬜ Mac Mini runner registration (needs registration tokens; setup script ready)
- ⬜ S3 secrets configured (`SCREENSHOT_S3_ACCESS_KEY_ID` / `SCREENSHOT_S3_SECRET_ACCESS_KEY`)
- ⬜ End-to-end run on real infra
- ⬜ Org-level runner pool (needs `adobecom` org admin to make Mac Minis usable by any consuming repo)
- ⬜ CORS / Helix-proxy decision for browser → internal S3 reads
- ⬜ S3 lifecycle policy (auto-delete old runs)
- ⬜ Upstream PR

## Action Plan

### Phase 1 — Infra setup (this week)

| # | Task | Owner | Deps |
|---|---|---|---|
| 1.1 | Register first Mac Mini (`sj1010122072233`) as repo-level runner on `JackySun9/milo` | Jacky | GitHub registration token |
| 1.2 | Configure `SCREENSHOT_S3_ACCESS_KEY_ID` + `SCREENSHOT_S3_SECRET_ACCESS_KEY` as repo secrets | Jacky | S3 service-account credentials |
| 1.3 | Trigger first real workflow run, verify S3 upload | Jacky | 1.1 + 1.2 |
| 1.4 | Submit CORS PR to `adobecom/nala-auto` + verify Milo UI reads back | Jacky | 1.3 |

### Phase 2 — Pool setup (next week)

| # | Task | Owner | Deps |
|---|---|---|---|
| 2.1 | Register remaining 2 Mac Minis | Jacky | Phase 1 done |
| 2.2 | Decide org-level vs repo-level | Jacky + adobecom admin | Need adobecom admin permission |
| 2.3 | If org-level: re-register all 3 at org scope | adobecom admin | 2.2 |
| 2.4 | If repo-level: enumerate consuming repos and onboard each | each consuming team | 2.2 |

### Phase 3 — Hardening (week 3)

| # | Task | Owner | Deps |
|---|---|---|---|
| 3.1 | S3 lifecycle policy (e.g. delete runs older than 30 days) | S3 admin | — |
| 3.2 | If browser CORS fails: add Helix proxy function | Milo team | Phase 1.4 |
| 3.3 | Migrate nala's existing visual tests to use this tool | Jacky | Phases 1+2 |

### Phase 4 — Upstream PR (week 4)

| # | Task | Owner | Deps |
|---|---|---|---|
| 4.1 | PR `JackySun9/milo` → `adobecom/milo` | Jacky | Phases 1-3 stable |
| 4.2 | Address review feedback | Jacky | 4.1 |
| 4.3 | Announce in #adobe-web (or relevant channel) | Jacky | merged |

## Open questions / risks

### Q1. Org-level runner registration

**Status:** Currently no org-level self-hosted runner pool exists in
`adobecom`. Registering at org scope requires admin permission. Workaround:
register at repo scope on `adobecom/milo` (when PR'd) and let consumer
repos forward via reusable workflow if they're in the same org.

**Risk:** If we stay repo-scoped on `adobecom/milo`, the runners are "Milo's
runners" politically. Other teams may want their own. Org-level is the
right long-term answer.

**Action needed:** Identify `adobecom` org admin and start the conversation
in parallel with Phase 1.

### Q2. Browser → nala-auto CORS

Milo UI fetches via `nala-auto.corp.adobe.com/api/milo/...` (not S3
directly). nala-auto's preflight already returns `Access-Control-Allow-Methods`
and `Vary: Origin`, but the actual response is missing
`Access-Control-Allow-Origin: https://milo.adobe.com` (or `*`).

**Fix:** ~3-line PR to
[`adobecom/nala-auto`](https://github.com/adobecom/nala-auto) — add an
`onProxyRes` hook in their `http-proxy-middleware` config that sets the
ACAO header.

**Pre-condition:** User is on Adobe corp network / VPN (nala-auto is
internal).

### Q3. Authentication for triggering workflows

Currently the UI opens the GitHub workflow page in a new tab — user clicks
"Run workflow" themselves. This avoids putting a GitHub PAT in browser
JavaScript.

For a production-grade v2, options are:
- A backend service holding a service-account PAT that the UI calls
- IMS-authenticated Helix function that calls GitHub on the user's behalf

**Action needed:** Decide on v2 trajectory after v1 is in users' hands.

### Q4. Concurrency limits

Three Mac Minis = three concurrent jobs. If many teams use this, we'll
queue. Monitor in Phase 2 and decide whether to add more hardware.

## How to evaluate this PoC yourself

```bash
# Clone the fork
git clone https://github.com/JackySun9/milo.git
cd milo
git checkout screenshot-diff-tool
cd tools/screenshot-diff

# Install
npm install
npx playwright install chromium

# Run a comparison locally (no infra needed)
URL_A="https://main--milo--adobecom.aem.live/" \
URL_B="https://main--milo--adobecom.aem.page/" \
PROJECT="my-test" \
node run.js

# Inspect output
ls screenshots/my-test/
open screenshots/my-test/shot-diff.png
```

## References

- Source: [`adobecom/nala/libs/screenshot/`](https://github.com/adobecom/nala/tree/main/libs/screenshot)
- Target branch: [`JackySun9/milo` `screenshot-diff-tool`](https://github.com/JackySun9/milo/tree/screenshot-diff-tool/tools/screenshot-diff)
- Self-hosted runner setup: [Adobe wiki page](https://wiki.corp.adobe.com/spaces/adobedotcom/pages/3715918184/Set+up+GitHub+Actions+Self-Hosted+Runner)
- Tool README: [`tools/screenshot-diff/README.md`](./README.md)
