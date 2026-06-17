// ── src/api/server.ts ─────────────────────────────────────────────────────
// Zero-dependency HTTP API + static dashboard host. In production this is the
// Next.js app/api route handlers + Hono (Doc 01/05); the surface is identical.
// Run: npm run serve   (defaults to http://localhost:8787)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../db/client.ts";
import { seed } from "../db/seed.ts";
import * as repo from "../db/repo.ts";
import { getAccountContext } from "../db/repo.ts";
import { getConnector } from "../connectors/index.ts";
import { analyzeAccount } from "../agents/analyst.ts";
import { runLoop } from "../agents/orchestrator.ts";
import { approveAction, rejectAction } from "../worker/approvals.ts";
import { log } from "../shared/logger.ts";

const PORT = Number(process.env.PORT ?? 8787);
const INDEX = join(import.meta.dirname, "..", "web", "index.html");

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
};

function mapAction(r: Record<string, unknown>): Record<string, unknown> {
  const j = (k: string) => { try { return JSON.parse((r[k] as string) ?? "null"); } catch { return null; } };
  return {
    id: r.id, level: r.level, type: r.type, target: r.target_name, targetExternalId: r.target_external_id,
    rationale: r.rationale, evidence: j("evidence"), expectedImpact: j("expected_impact"),
    confidence: r.confidence, payload: j("payload"), rollback: j("rollback"),
    guardrailVerdict: r.guardrail_verdict, guardrailReasons: j("guardrail_reasons"),
    status: r.status, proposedByAgent: r.proposed_by_agent,
    proposedAt: r.proposed_at, decidedAt: r.decided_at, executedAt: r.executed_at,
  };
}

async function overview(acctId: string) {
  const ctx = getAccountContext(acctId);
  const report = await analyzeAccount(ctx, getConnector(ctx.platform));
  const t = report.adSets.reduce((a, s) => {
    a.spendMinor += s.window.spendMinor; a.conversions += s.window.conversions;
    a.roasW += s.window.roas * s.window.spendMinor; return a;
  }, { spendMinor: 0, conversions: 0, roasW: 0 });
  const counts = repo.countByStatus(acctId);
  return {
    account: {
      id: acctId, displayName: ctx.displayName, externalId: ctx.externalId, platform: ctx.platform,
      autonomy: ctx.autonomyLevel, status: ctx.status, targetKpi: ctx.targetKpi, targetValue: ctx.targetValue,
      monthlyCapMinor: ctx.guardrails.monthlyCapMinor, dailyCapMinor: ctx.guardrails.dailyCapMinor,
      monthSpendMinor: ctx.monthSpendMinor, daySpendMinor: ctx.daySpendMinor,
      conversionTrackingOk: ctx.conversionTrackingOk, guardrails: ctx.guardrails,
    },
    totals: {
      spendMinor: t.spendMinor, conversions: t.conversions,
      cpaMinor: t.conversions > 0 ? Math.round(t.spendMinor / t.conversions) : 0,
      roas: t.spendMinor > 0 ? +(t.roasW / t.spendMinor).toFixed(2) : 0,
      queued: counts["queued"] ?? 0,
    },
    adSets: report.adSets,
    ads: report.ads,
    tests: report.tests,
    series: repo.getAccountDailySeries(acctId, 14),
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(INDEX, "utf8"));
      return;
    }
    if (p === "/api/accounts" && method === "GET") {
      const accts = repo.listAccounts().map((a) => {
        const counts = repo.countByStatus(a.id);
        return {
          id: a.id, displayName: a.display_name, externalId: a.external_account_id,
          platform: a.platform, autonomy: a.autonomy_level, status: a.status,
          targetKpi: a.target_kpi, targetValue: a.target_value, queued: counts["queued"] ?? 0,
        };
      });
      return json(res, 200, accts);
    }
    if (p === "/api/insights" && method === "GET") return json(res, 200, repo.getInsights());

    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/api\/accounts\/([^/]+)\/overview$/)) && method === "GET")
      return json(res, 200, await overview(m[1]));
    if ((m = p.match(/^\/api\/accounts\/([^/]+)\/approvals$/)) && method === "GET")
      return json(res, 200, repo.listActions(m[1], ["queued"]).map(mapAction));
    if ((m = p.match(/^\/api\/accounts\/([^/]+)\/actions$/)) && method === "GET")
      return json(res, 200, repo.listActions(m[1]).map(mapAction));
    if ((m = p.match(/^\/api\/accounts\/([^/]+)\/audit$/)) && method === "GET")
      return json(res, 200, repo.listAudit(m[1]));
    if ((m = p.match(/^\/api\/accounts\/([^/]+)\/run-loop$/)) && method === "POST") {
      repo.clearAccountActions(m[1]);
      const s = await runLoop(m[1]);
      return json(res, 200, { ok: true, queued: s.queued, modified: s.modified, blocked: s.blocked, deferred: s.deferred, proposed: s.proposed });
    }
    if ((m = p.match(/^\/api\/accounts\/([^/]+)\/(kill|revive)$/)) && method === "POST") {
      const ctx = getAccountContext(m[1]);
      const killing = m[2] === "kill";
      repo.setAccountStatus(m[1], killing ? "killed" : "connected");
      repo.audit(ctx.orgId, m[1], "human", null, null, killing ? "kill_switch_engaged" : "kill_switch_released", null, null);
      return json(res, 200, { ok: true, status: killing ? "killed" : "connected" });
    }
    if ((m = p.match(/^\/api\/actions\/([^/]+)\/approve$/)) && method === "POST") {
      const body = await readBody(req);
      const r = await approveAction(m[1], String(body.note ?? ""));
      return json(res, 200, { ok: true, ...r });
    }
    if ((m = p.match(/^\/api\/actions\/([^/]+)\/reject$/)) && method === "POST") {
      const body = await readBody(req);
      rejectAction(m[1], String(body.note ?? ""));
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found", path: p });
  } catch (e) {
    log.error("request error", { err: String(e) });
    json(res, 500, { error: String(e) });
  }
});

migrate();
// Seed-on-boot so a fresh deploy (e.g. Render) has data immediately.
if (!repo.listAccounts().length) {
  log.info("empty database — seeding demo account on boot");
  seed();
}
server.listen(PORT, "0.0.0.0", () => {
  log.info(`AdPilot dashboard + API on http://0.0.0.0:${PORT}`);
});
