# AdPilot — Autonomous AI Performance‑Marketing Engine

**Runnable Phase 0 → Phase 1 MVP**, built from the 8‑document specification.

> One‑liner: takes a client brief and runs, optimises, and iterates Meta PPC
> campaigns — proposing changes inside hard guardrails — and compounds what it
> learns across accounts.

This is the **MVP the spec itself tells Cowork to build** (README "Start‑here",
Doc 07 "Build Phase 0 → 1 first and stop"): the OODA optimisation loop running
in **Co‑pilot** mode against a **seeded Meta test account**, proposing ranked
actions into an approval queue — **with zero live spend**. The deterministic
guardrail engine (the spec's "single most important component") is included so
the safety story is real, not promised.

It runs on **Node 22+ with no dependencies to install** (uses native
TypeScript execution and the built‑in `node:sqlite`).

---

## Live demo & deploy

**Live app:** **https://adpilot-nhro.onrender.com** · _(Render free tier — first hit after idle may take ~40s to wake)_

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hemantsatishjadhav06-ai/adpilot)

One-click via the button (uses `render.yaml`), or with Docker locally:

```bash
docker build -t adpilot . && docker run -p 8787:8787 adpilot   # → http://localhost:8787
```

The deployed server migrates and **seeds-on-boot**, so a fresh instance shows live data immediately. Writes stay in dry-run (`ADPILOT_DRY_RUN=1`) — nothing touches a real ad account.

## Quickstart

```bash
cd adpilot
npm run demo     # seed → OODA loop → approval queue → approve → dry-run execute → audit
# then the live dashboard:
npm start        # = seed + serve;  open http://localhost:8787
```

No API keys, no cloud, no `npm install`. (Requires Node ≥ 22.6 for `--experimental-strip-types` + `node:sqlite`.)

Individual steps:

```bash
npm run seed     # build a realistic Meta test account in SQLite
npm run loop     # run the OODA loop once for every account
npm run serve    # dashboard + JSON API on :8787
```

---

## What it actually does

The seed creates one Meta account (**Acme Fitness D2C**, target CPA ₹300,
Co‑pilot, monthly cap ₹5,00,000) with five ad sets deliberately engineered to
exercise every decision path. One `npm run loop` produces:

| Proposal | Guardrail verdict | Why |
|---|---|---|
| **Pause** `Retargeting 7d` | ✅ allow (urgent) | CPA ₹1,009 = 3.4× target, sustained → pause‑on‑anomaly |
| **Pause** `Static B` | ✅ allow | Lost A/B test, P(winner>loser)=**0.996** ≥ 0.95 |
| **Reduce budget** `Broad — Cold` | ✅ allow | CPA ₹548 = 1.83× target → cut 30%, don't pause |
| **Refresh creative** `Carousel C` | ✅ allow | Frequency 5.3 + CTR −42% → fatigue |
| **Scale budget** `Lookalike 1%` | ⚠️ **modify** | Winner; optimizer asked +35%, capped to **+25%/24h** |
| **Reduce budget** `New Test` | ⛔ **block** | Ad set in **learning phase** — edit would reset learning |
| **Expand audience** `Interest` | ⏸️ **deferred** | Allowed, but over the **5 actions/cycle** blast‑radius cap |

Approving an action routes it to the **Media Buyer** (the sole writer), which
executes in **dry‑run** (logs the exact payload, never calls Meta), updates the
local mirror, and writes append‑only audit records with a rollback payload.

---

## Architecture → spec mapping

```
src/
  shared/        types.ts (ProposedAction contract — Doc 02 §4), money.ts, logger.ts
  db/            schema.sql (Doc 04), client.ts (node:sqlite), repo.ts, seed.ts
  connectors/    types.ts (AdConnector — Doc 06 §3), meta-mock.ts (dry-run), shared.ts (rate/idem)
  guardrails/    engine.ts + rules/{spend,cadence,significance,blastRadius}.ts, kill-switch.ts (Doc 03 §3)
  analytics/     metrics.ts, fatigue.ts, significance.ts (Bayesian Beta-Binomial — Doc 03 §4)
  agents/        analyst.ts, optimizer.ts, media-buyer.ts, orchestrator.ts, prompts/optimizer/v1.md (Doc 02)
  llm/           route-model.ts (Opus/Sonnet/Haiku routing — Doc 01 §2), client.ts (optional)
  worker/        loop.ts (Inngest fan-out logic), approvals.ts
  api/           server.ts (node:http API + dashboard host)
  web/           index.html (overview · approval queue · activity/audit · flywheel)
scripts/demo.ts  narrated end-to-end run
```

The **import boundaries** the spec demands (Doc 05) hold: agents call
`guardrails` / `connectors` / `analytics`, only the **Media Buyer** calls
connector *write* methods, and `guardrails` are pure functions. The single
`ProposedAction` contract flows propose → guardrail → queue → approve →
execute → audit → (rollback).

---

## Safety model (Doc 03)

- **Co‑pilot default**: nothing executes without a human approval click.
- **Deterministic guardrail engine**: an LLM proposes; plain code decides. Spend
  caps, learning‑phase locks, min‑data significance gates, blast‑radius cap.
- **Dry‑run connector**: `ADPILOT_DRY_RUN=1` (default) — writes are logged, never sent.
- **Kill switch**: per account; blocks 100% of writes when engaged.
- **Append‑only audit log** with before/after + rollback on every lifecycle event.
- **Conversion‑tracking onboarding gate**: the loop won't optimise toward a
  signal it can't trust.

---

## What's mocked vs. the production spec (and how to graduate)

This is an honest MVP, not the deployed SaaS. Deviations, each behind a clean seam:

| MVP here | Production spec | How to swap |
|---|---|---|
| `node:sqlite` file | Supabase/Postgres + RLS + Drizzle (Doc 04) | `db/repo.ts` is the only data surface — reimplement against Supabase; add RLS policies |
| Mock Meta connector, dry‑run | `facebook-nodejs-business-sdk`, live (Doc 06) | implement `AdConnector` in `connectors/meta/`; the interface is unchanged |
| Deterministic optimizer | Claude (Opus/Sonnet) tool‑use (Doc 02) | `llm/` + `prompts/optimizer/v1.md` are wired; set `ADPILOT_USE_LLM=1` + key |
| In‑process loop runner | Inngest durable steps (Doc 01/05) | `worker/loop.ts` maps 1:1 to an Inngest function |
| TS Bayesian test | FastAPI `scipy`/`statsmodels` (Doc 01 §3) | `analytics/significance.ts` → thin client; gates already encoded |
| Google connector | Phase 4 | add `connectors/google-ads/` behind `AdConnector` |

**Before any live account**: complete Meta App Review / Business Verification
(Doc 06 — the weeks‑long long pole), keep the guardrail engine + audit log +
kill switch in front of every write, and start on a low‑budget account only.

---

## Design & accessibility

The dashboard's colour system is derived in the **OKLab / OKLch** perceptual
colour space (so hues stay equally vivid across light and dark themes), then
every text-on-surface pair is checked against **WCAG 2.1 AA** contrast. Measured
ratios (dark theme, on the panel surface):

| Token | Hex | Contrast | WCAG AA |
|---|---|---|---|
| text primary | `#D8DDE3` | 13.1:1 | ✅ (needs ≥4.5) |
| text secondary | `#979EA4` | 6.6:1 | ✅ |
| text tertiary / muted | `#7B8187` | 4.5:1 | ✅ |
| accent green / amber / red / blue / violet | — | ≥4.5:1 each | ✅ |

Light theme primary text is 13.2:1; all accents are ≥4.5:1 on white. Other UX
details: a persisted light/dark toggle (respects `prefers-color-scheme`),
`prefers-reduced-motion` support, visible keyboard focus rings, ARIA tab
semantics, a skip link, translucent tints mixed in OKLab via CSS
`color-mix(in oklab, …)`, and skeleton loading states. References:
[WCAG 2.1 contrast minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html),
[OKLab](https://bottosson.github.io/posts/oklab/).

## API

```
GET  /api/accounts                      GET  /api/accounts/:id/overview
GET  /api/accounts/:id/approvals        GET  /api/accounts/:id/actions
GET  /api/accounts/:id/audit            GET  /api/insights
POST /api/accounts/:id/run-loop         POST /api/accounts/:id/kill | /revive
POST /api/actions/:id/approve           POST /api/actions/:id/reject
```
