// Admin settings "向量服务": the embeddings service entered on the page when the environment has none. The key is
// sealed in settings (lib/secret-box.ts) and never returned; every change is audited without it.
import { z } from "zod";
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { seal } from "../lib/secret-box.ts";
import { keyHint } from "../providers/model-providers.ts";
import {
  EMBEDDING_PURPOSE, EMBEDDING_SETTING, embeddingService, invalidateEmbeddingService, testEmbedding, type StoredEmbedding,
} from "../providers/embeddings.ts";

const Input = z.object({
  baseUrl: z.string().trim().url().refine((u) => /^https?:\/\//.test(u), "baseUrl must be http(s)").transform((u) => u.replace(/\/+$/, "")),
  model: z.string().trim().min(1).max(200),
  dims: z.number().int().min(0).max(8192),
  apiKey: z.string().min(8).max(512).regex(/^[\x21-\x7e]+$/, "the key has spaces or unusual characters").optional(),
  enabled: z.boolean().default(true),
}).strict();

/** For the settings page: what is in use (and where it comes from) and what the page holds. */
export async function embeddingSettings() {
  const [row] = await sql<{ value: StoredEmbedding; updated_at: Date }[]>`SELECT value, updated_at FROM settings WHERE key = ${EMBEDDING_SETTING}`;
  const inUse = await embeddingService();
  const s = row?.value;
  return {
    inUse: inUse ? { source: inUse.source, model: inUse.model, dims: inUse.dims, baseUrl: inUse.baseUrl } : null,
    stored: s ? { baseUrl: s.baseUrl, model: s.model, dims: s.dims, keyHint: s.keyHint, enabled: s.enabled, updatedBy: s.updatedBy, updatedAt: row!.updated_at } : null,
  };
}

export async function saveEmbedding(raw: unknown, reason: string, actor: string) {
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  const parsed = Input.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw Object.assign(new Error(`${issue.path.join(".") || "input"}: ${issue.message}`), { statusCode: 400 });
  }
  const input = parsed.data;
  const [row] = await sql<{ value: StoredEmbedding }[]>`SELECT value FROM settings WHERE key = ${EMBEDDING_SETTING}`;
  const before = row?.value ?? null;
  if (!before && !input.apiKey) throw Object.assign(new Error("apiKey: 第一次配置必须填写密钥"), { statusCode: 400 });
  const secret = credential("auth", "SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const value: StoredEmbedding = {
    baseUrl: input.baseUrl, model: input.model, dims: input.dims, enabled: input.enabled, updatedBy: actor,
    keyEnc: input.apiKey ? seal(input.apiKey, secret, EMBEDDING_PURPOSE) : before!.keyEnc,
    keyHint: input.apiKey ? keyHint(input.apiKey) : before!.keyHint,
  };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${EMBEDDING_SETTING}, ${sql.json(value as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  invalidateEmbeddingService();
  const shown = (v: StoredEmbedding | null) => (v ? { baseUrl: v.baseUrl, model: v.model, dims: v.dims, enabled: v.enabled, key: v.keyHint } : null);
  await audit(actor, "settings.embedding", "settings:embedding", reason, shown(before), shown(value));
  return { saved: true, keyChanged: !!input.apiKey };
}

export async function checkEmbedding() {
  invalidateEmbeddingService();
  return testEmbedding();
}
