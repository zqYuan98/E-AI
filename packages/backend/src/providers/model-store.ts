// Model providers entered on the admin page. The API key is sealed (lib/secret-box.ts) with the deployment's
// SESSION_SECRET: the page can write it but never read it back, and a database copy holds only ciphertext.
// llm.ts reads them into the model registry; admin/model-providers.ts changes them.
import { sql } from "../db.ts";
import { credential } from "../config.ts";
import { open, seal } from "../lib/secret-box.ts";

export interface StoredProvider {
  key: string;
  label: string;
  model: string;
  baseUrl: string;
  /** Null when the sealed key cannot be opened (SESSION_SECRET changed): the provider is listed but not usable. */
  apiKey: string | null;
  keyHint: string;
  extra: Record<string, unknown> | null;
  reasoningTokens: number | null;
  maxConcurrency: number | null;
  jsonMode: boolean;
  vision: boolean;
  enabled: boolean;
  updatedBy: string;
  updatedAt: Date;
}

interface Row {
  key: string; label: string; model: string; base_url: string; api_key_enc: string; api_key_hint: string; extra: Record<string, unknown> | null;
  reasoning_tokens: number | null; max_concurrency: number | null; json_mode: boolean; vision: boolean; enabled: boolean; updated_by: string; updated_at: Date;
}

const purpose = (key: string) => `model-provider:${key}`;

function secret(): string {
  const s = credential("auth", "SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

export const sealApiKey = (key: string, apiKey: string) => seal(apiKey, secret(), purpose(key));

export async function loadStoredProviders(): Promise<StoredProvider[]> {
  const rows = await sql<Row[]>`
    SELECT key, label, model, base_url, api_key_enc, api_key_hint, extra, reasoning_tokens, max_concurrency, json_mode, vision, enabled, updated_by, updated_at
    FROM model_providers ORDER BY key`;
  const s = credential("auth", "SESSION_SECRET");
  return rows.map((r) => ({
    key: r.key, label: r.label, model: r.model, baseUrl: r.base_url, apiKey: s ? open(r.api_key_enc, s, purpose(r.key)) : null, keyHint: r.api_key_hint,
    extra: r.extra, reasoningTokens: r.reasoning_tokens, maxConcurrency: r.max_concurrency, jsonMode: r.json_mode, vision: r.vision, enabled: r.enabled, updatedBy: r.updated_by, updatedAt: r.updated_at,
  }));
}
