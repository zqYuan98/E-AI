// Admin "模型服务商": providers added, changed, stopped and removed on the page instead of in the environment.
// The key is sealed in the database and never returned; every change is audited without it.
import type { AdminModelProvider, BeforeJson } from "@aihot/contracts/admin";
import { PRESETS } from "@aihot/site/models";
import { sql } from "../db.ts";
import { audit, Conflict } from "../audit.ts";
import { keyHint, parseStoredProviderInput, PROVIDER_KEY } from "../providers/model-providers.ts";
import { loadStoredProviders, sealApiKey } from "../providers/model-store.ts";
import { envProviderKeys, invalidateStoredModels, MODELS, refreshStoredModels } from "../providers/llm.ts";
import { capabilities, invalidateModelCache } from "../editorial/models.ts";

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** Steps whose model is switched (on the admin page) to this provider. */
async function stepsUsing(key: string): Promise<string[]> {
  const rows = await sql<{ key: string }[]>`SELECT key FROM settings WHERE key LIKE 'models.%' AND value->>'model' = ${key}`;
  const labels = capabilities();
  return rows.map((r) => r.key.slice("models.".length)).map((k) => labels[k]?.label.split("（")[0] ?? k);
}

export async function listProviders(): Promise<BeforeJson<AdminModelProvider>[]> {
  const rows = await loadStoredProviders();
  const out: BeforeJson<AdminModelProvider>[] = [];
  for (const r of rows) {
    out.push({
      key: r.key, label: r.label, model: r.model, baseUrl: r.baseUrl, source: "admin", keyHint: r.keyHint, keyReadable: r.apiKey !== null, enabled: r.enabled,
      vision: r.vision, jsonMode: r.jsonMode, reasoningTokens: r.reasoningTokens, maxConcurrency: r.maxConcurrency, extra: r.extra, updatedBy: r.updatedBy, updatedAt: r.updatedAt, usedBy: await stepsUsing(r.key),
    });
  }
  for (const key of envProviderKeys()) {
    const m = MODELS[key]!;
    out.push({
      key, label: key, model: m.model, baseUrl: m.baseUrl ?? "", source: "env", keyHint: m.apiKeyEnv, keyReadable: true, enabled: true, vision: !!m.vision, jsonMode: m.jsonMode,
      reasoningTokens: m.reasoningTokens ?? null, maxConcurrency: m.maxConcurrency ?? null, extra: m.extra ?? null, updatedBy: "环境变量", updatedAt: null, usedBy: await stepsUsing(key),
    });
  }
  return out;
}

/** Adds a provider (the key is required) or changes one (an omitted key stays). */
export async function saveProvider(key: string, raw: unknown, reason: string, actor: string) {
  if (!PROVIDER_KEY.test(key)) throw bad("标识：2–49 位小写字母、数字或 . _ -");
  if (!reason.trim()) throw bad("a reason is required");
  const input = parseStoredProviderInput(raw);
  await refreshStoredModels(true);
  const [existing] = await sql<{ api_key_hint: string; enabled: boolean }[]>`SELECT api_key_hint, enabled FROM model_providers WHERE key = ${key}`;
  // Presets, the default model and MODEL_PROVIDERS names belong to the deployment.
  if (!existing && (key === "default" || key in PRESETS || envProviderKeys().includes(key) || MODELS[key])) throw bad("这个标识已经是内置或环境变量里的模型名，换一个");
  if (!existing && !input.apiKey) throw bad("apiKey: 新增服务商必须填写密钥");
  const sealed = input.apiKey ? sealApiKey(key, input.apiKey) : null;
  const hint = input.apiKey ? keyHint(input.apiKey) : null;
  const extra = input.extra && Object.keys(input.extra).length ? sql.json(input.extra as never) : null;
  await sql`
    INSERT INTO model_providers (key, label, model, base_url, api_key_enc, api_key_hint, extra, reasoning_tokens, max_concurrency, json_mode, vision, enabled, updated_by)
    VALUES (${key}, ${input.label}, ${input.model}, ${input.baseUrl}, ${sealed ?? ""}, ${hint ?? ""}, ${extra}, ${input.reasoningTokens || null}, ${input.maxConcurrency || null}, ${input.jsonMode}, ${input.vision}, ${input.enabled}, ${actor})
    ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, model = EXCLUDED.model, base_url = EXCLUDED.base_url,
      api_key_enc = CASE WHEN ${sealed}::text IS NULL THEN model_providers.api_key_enc ELSE EXCLUDED.api_key_enc END,
      api_key_hint = CASE WHEN ${sealed}::text IS NULL THEN model_providers.api_key_hint ELSE EXCLUDED.api_key_hint END,
      extra = EXCLUDED.extra, reasoning_tokens = EXCLUDED.reasoning_tokens, max_concurrency = EXCLUDED.max_concurrency, json_mode = EXCLUDED.json_mode, vision = EXCLUDED.vision,
      enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  invalidateStoredModels();
  invalidateModelCache();
  await refreshStoredModels(true);
  const shown = { label: input.label, model: input.model, baseUrl: input.baseUrl, maxConcurrency: input.maxConcurrency ?? null, enabled: input.enabled, vision: input.vision, jsonMode: input.jsonMode, key: hint ?? existing?.api_key_hint ?? null };
  await audit(actor, existing ? "models.provider.update" : "models.provider.create", `provider:${key}`, reason, existing ? { enabled: existing.enabled, key: existing.api_key_hint } : null, shown);
  return { key, created: !existing, keyChanged: !!sealed };
}

/** Removes a provider nothing is switched to. */
export async function deleteProvider(key: string, reason: string, actor: string) {
  if (!reason.trim()) throw bad("a reason is required");
  const used = await stepsUsing(key);
  if (used.length) throw new Conflict(`还有步骤在用它：${used.join("、")}。先到下面把这些步骤切换到别的模型`);
  const [gone] = await sql<{ label: string; model: string }[]>`DELETE FROM model_providers WHERE key = ${key} RETURNING label, model`;
  if (!gone) throw bad("unknown provider");
  invalidateStoredModels();
  await refreshStoredModels(true);
  await audit(actor, "models.provider.delete", `provider:${key}`, reason, { label: gone.label, model: gone.model }, null);
  return { key };
}
