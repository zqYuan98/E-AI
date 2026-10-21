// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import type { AdminModels, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { capabilities, capabilityAcceptsModel, fallbackModelFor, invalidateModelCache, modelSources } from "../editorial/models.ts";
import { z } from "zod";
import { chatJson, MODELS, modelProvidersError, refreshStoredModels } from "../providers/llm.ts";
import { modelCircuits } from "../providers/circuit.ts";
import { listProviders } from "./model-providers.ts";
import { audit } from "../audit.ts";

interface UsageRow {
  purpose: string;
  model: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  /** Prompt tokens served from the provider's cache, among those without a cost of their own. */
  tokens_cached: string | null;
  tokens_out: string | null;
  /** Of calls without a cost of their own. */
  tokens_in_uncosted: string | null;
  tokens_out_uncosted: string | null;
  actual_cost: string | null;
  currency: string | null;
}

export async function modelsOverview(days = 7): Promise<BeforeJson<AdminModels>> {
  await refreshStoredModels(true);
  const since = new Date(Date.now() - days * 86400_000);
  const [sources, circuits, usage, prices, history, benches] = await Promise.all([
    modelSources(),
    modelCircuits(),
    sql<UsageRow[]>`
      SELECT r.purpose, a.model, r.request->>'promptVersion' AS prompt_version, count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
             sum((a.usage->>'prompt_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_in_uncosted,
             sum((a.usage->>'completion_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_out_uncosted,
             sum(coalesce((a.usage->'prompt_tokens_details'->>'cached_tokens')::bigint, (a.usage->>'prompt_cache_hit_tokens')::bigint, 0)) FILTER (WHERE a.cost IS NULL) AS tokens_cached,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost, max(a.currency) AS currency
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL
      GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC`,
    sql<{ service: string; model: string; currency: string; input_per_mtok: string | null; cached_per_mtok: string | null; output_per_mtok: string | null }[]>`
      SELECT service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok FROM service_prices`,
    sql<BeforeJson<AdminModels["history"][number]>[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`,
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
  ]);
  const serviceOf = (model: string) => Object.values(MODELS).find((m) => m.model === model || m.key === model)?.service ?? null;
  // Cached prompt tokens at the cache price, the rest at the input price; calls that carry their own cost
  // are not estimated again.
  const priced = (u: UsageRow) => {
    const service = u.model ? serviceOf(u.model) : null;
    const p = prices.find((x) => x.service === service && x.model === u.model) ?? prices.find((x) => x.service === service && x.model === "");
    if (!p || (!p.input_per_mtok && !p.output_per_mtok)) return null;
    const cached = Number(u.tokens_cached ?? 0);
    const fresh = Number(u.tokens_in_uncosted ?? 0) - cached;
    const amount = (fresh / 1e6) * Number(p.input_per_mtok ?? 0) + (cached / 1e6) * Number(p.cached_per_mtok ?? p.input_per_mtok ?? 0) + (Number(u.tokens_out_uncosted ?? 0) / 1e6) * Number(p.output_per_mtok ?? 0);
    return { amount, currency: p.currency };
  };
  const steps = Object.entries(capabilities()).map(([key, c]) => {
    const backup = fallbackModelFor(key, sources[key]!.model);
    const primaryCircuit = circuits[MODELS[sources[key]!.model]!.service];
    const backupCircuit = backup ? circuits[MODELS[backup]!.service] : undefined;
    return {
      key,
      label: c.label,
      env: c.env,
      defaultModel: c.default,
      vision: !!c.vision,
      current: sources[key]!,
      fallback: backup ? { model: backup, primaryPaused: !!primaryCircuit?.openUntil, backupPaused: !!backupCircuit?.openUntil,
        nextProbeAt: primaryCircuit?.openUntil ? new Date(Math.max(primaryCircuit.openUntil, primaryCircuit.probeUntil)).toISOString() : null } : null,
      usage: usage
        .filter((u) => c.purposes.includes(u.purpose))
        .map((u) => ({
          purpose: u.purpose,
          model: u.model,
          promptVersion: u.prompt_version,
          calls: u.calls,
          ok: u.ok,
          failed: u.failed,
          unknown: u.unknown,
          p50: u.p50,
          p95: u.p95,
          tokensIn: Number(u.tokens_in ?? 0),
          tokensOut: Number(u.tokens_out ?? 0),
          actualCost: u.actual_cost === null ? null : Number(u.actual_cost),
          currency: u.currency,
          estimate: priced(u),
        })),
    };
  });
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  return { days, capabilities: steps, choices, providersError: modelProvidersError, providers: await listProviders(), history, benches };
}

/** Switches a capability to another registered model (or back to the environment/default when null). */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  await refreshStoredModels();
  const c = capabilities()[capability];
  if (!c) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (model !== null) {
    const spec = MODELS[model];
    if (!spec) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
    if (!capabilityAcceptsModel(c, spec)) throw Object.assign(new Error("this capability needs a vision model"), { statusCode: 400 });
  }
  const before = (await modelSources())[capability];
  if (model === null) await sql`DELETE FROM settings WHERE key = ${`models.${capability}`}`;
  else {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`models.${capability}`}, ${sql.json({ model })}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  invalidateModelCache();
  const after = (await modelSources())[capability];
  await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after ?? null);
  return { capability, before, after };
}

/**
 * Switches every step to one registered model, for a provider change (the old one has no balance). Each step is
 * switched and audited like a single switch; steps that need images are skipped when the model cannot read them.
 */
export async function switchAllModels(model: string, reason: string, actor: string) {
  await refreshStoredModels(true);
  const spec = MODELS[model];
  if (!spec) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  const switched: string[] = [];
  const skipped: string[] = [];
  for (const [key, c] of Object.entries(capabilities())) {
    if (!capabilityAcceptsModel(c, spec)) { skipped.push(key); continue; }
    await switchModel(key, model, reason, actor);
    switched.push(key);
  }
  return { model, switched, skipped };
}

/** One tiny paid call to a registered model, to see whether its address, key and balance work before switching to it. */
export async function testModel(model: string) {
  await refreshStoredModels(true);
  if (!MODELS[model]) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
  const started = Date.now();
  try {
    await chatJson({
      model, purpose: "model_check", subject: `check:${model}`, promptVersion: "check-1", attemptTag: String(started),
      system: "Reply with the JSON object {\"ok\": true} and nothing else.", user: "ping", maxTokens: 64, timeoutMs: 30_000,
      schema: z.object({ ok: z.boolean() }),
    });
    return { model, ok: true, ms: Date.now() - started, error: null };
  } catch (error) {
    // The message names the provider's refusal (HTTP status, balance); the request carries no key.
    const message = String((error as Error).message);
    // The valve is the deployment's: say what to change instead of the internal message.
    const error_ = /Model calls are disabled/.test(message)
      ? "模型调用总开关还没打开：在服务器 .env 里把 MODEL_CALLS_ENABLED 改成 true，重启 api 和 worker 后再测试（COLLECT_ENABLED 可以继续关着，不会开始采集）"
      : message.slice(0, 400);
    return { model, ok: false, ms: Date.now() - started, error: error_ };
  }
}
