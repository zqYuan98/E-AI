// Text embeddings through receipts, used only for recall. Any OpenAI-compatible /embeddings endpoint
// (EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL); with a DashScope key and nothing else set,
// Aliyun text-embedding-v4 at 1024 dimensions. Without either, the service entered on the admin settings page
// (its key sealed in the database). Without any, recall compares the texts themselves.
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { z } from "zod";
import { ModelOutputError } from "./llm.ts";
import { completeReceipt, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";
import { ModelCallsPaused, modelCallsOn } from "../operations/switches.ts";
import { open } from "../lib/secret-box.ts";

const own = !!credential("models", "EMBEDDING_API_KEY");
/** The environment's model and size (EMBEDDING_* or DashScope); the admin page's service has its own. */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || (own ? "text-embedding-3-small" : "text-embedding-v4");
/** Requested dimensions, when the provider takes the parameter (0 leaves it to the model). */
export const EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS ?? (own ? 0 : 1024));

export interface EmbeddingService {
  source: "env" | "admin";
  service: string;
  model: string;
  /** Requested dimensions (0 leaves the size to the model). */
  dims: number;
  baseUrl: string;
  apiKey: string;
}

/** The admin page's service as stored (settings `embedding.service`); the key sealed for the purpose `embedding`. */
export interface StoredEmbedding { baseUrl: string; model: string; dims: number; keyEnc: string; keyHint: string; enabled: boolean; updatedBy: string }
export const EMBEDDING_SETTING = "embedding.service";
export const EMBEDDING_PURPOSE = "embedding-service";
let stored: { at: number; value: StoredEmbedding | null } | null = null;
export const invalidateEmbeddingService = () => { stored = null; };

async function storedService(): Promise<StoredEmbedding | null> {
  if (stored && Date.now() - stored.at < 30_000) return stored.value;
  const [row] = await sql<{ value: StoredEmbedding }[]>`SELECT value FROM settings WHERE key = ${EMBEDDING_SETTING}`;
  stored = { at: Date.now(), value: row?.value ?? null };
  return stored.value;
}

/** The service in use: the environment's when it has a key (the deployment decides), else the admin page's, else none. */
export async function embeddingService(): Promise<EmbeddingService | null> {
  const ownKey = credential("models", "EMBEDDING_API_KEY");
  if (ownKey) return { source: "env", service: "embedding", model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, baseUrl: credential("models", "EMBEDDING_BASE_URL") ?? "https://api.openai.com/v1", apiKey: ownKey };
  const dashscope = credential("models", "DASHSCOPE_API_KEY");
  if (dashscope) return { source: "env", service: "dashscope", model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, baseUrl: credential("models", "DASHSCOPE_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: dashscope };
  const s = await storedService();
  const secret = credential("auth", "SESSION_SECRET");
  const apiKey = s?.enabled && secret ? open(s.keyEnc, secret, EMBEDDING_PURPOSE) : null;
  return s && apiKey ? { source: "admin", service: "embedding", model: s.model, dims: s.dims, baseUrl: s.baseUrl, apiKey } : null;
}

/** A vector of the configured size; a stored one of another size (the size changed) is computed again. */
const vectorOf = (dims: number) => (dims > 0 ? z.array(z.number()).length(dims) : z.array(z.number()).min(1));

/** Embeddings are paid model calls: off with MODEL_CALLS_ENABLED=false or paused on the admin page, like every other call. */
export async function embeddingsAvailable(): Promise<boolean> {
  return (await modelCallsOn()) && !!(await embeddingService());
}

async function embedBatch(texts: string[], subject: string, purpose = "embedding"): Promise<{ vectors: number[][]; receiptId: number }> {
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  if (!(await modelCallsOn())) throw new ModelCallsPaused();
  const svc = await embeddingService();
  if (!svc) throw new Error("No embedding service: EMBEDDING_API_KEY, DASHSCOPE_API_KEY or the admin settings page");
  const { service: SERVICE, model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, baseUrl: base, apiKey: key } = svc;
  const VECTOR = vectorOf(EMBEDDING_DIMS);
  const receipt = await paidRequest(
    { service: SERVICE, model: EMBEDDING_MODEL, purpose, subject, identity: { model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, texts: texts.map((t) => sha256(t)) }, requestSummary: { count: texts.length } },
    async () => {
      const res = await fetch(`${base.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, ...(EMBEDDING_DIMS > 0 ? { dimensions: EMBEDDING_DIMS } : {}), encoding_format: "float" }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderRejectedError(`embeddings HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, res.status === 429 || res.status >= 500);
      let response: unknown;
      try { response = JSON.parse(text); }
      catch { response = { unparsable: text.slice(0, 20000) }; }
      const usage = response && typeof response === "object" && "usage" in response
        ? response.usage as Record<string, unknown> : null;
      return { response, usage, cost: null };
    },
  );
  try {
    const { data } = z.object({ data: z.array(z.object({
      index: z.number().int().nonnegative(), embedding: VECTOR,
    })).length(texts.length) }).parse(receipt.response);
    data.sort((a, b) => a.index - b.index);
    if (data.some((item, index) => item.index !== index)) throw new Error("Embedding indices do not match inputs");
    return { vectors: data.map((item) => item.embedding), receiptId: receipt.receiptId };
  } catch (error) {
    await rejectReceivedResponse(receipt.receiptId, `unusable embeddings: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Embedding response is unusable for ${subject}: ${String(error).slice(0, 300)}`, receipt.receiptId);
  }
}

// array_send avoids formatting each float as decimal on the database. Its one-dimensional real[]
// payload has a 20-byte header, then a four-byte length and a float4 per coordinate. Keep shapes
// rejected by the text-array reader invalid so the usual replacement path still handles them.
function storedVector(data: Buffer): number[] | null {
  if (data.readInt32BE(0) !== 1 || data.readInt32BE(16) !== 1) return null;
  const vector = new Array<number>(data.readInt32BE(12));
  for (let i = 0; i < vector.length; i++) {
    if (data.readInt32BE(20 + i * 8) === -1) return null;
    vector[i] = data.readFloatBE(24 + i * 8);
  }
  return vector;
}

/** Returns the stored embeddings of report texts, computing and storing the missing ones. */
export async function ensureEmbeddings(items: Array<{ id: string; text: string }>): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (items.length === 0) return out;
  const svc = await embeddingService();
  if (!svc) throw new Error("No embedding service: EMBEDDING_API_KEY, DASHSCOPE_API_KEY or the admin settings page");
  const { model: EMBEDDING_MODEL } = svc;
  const VECTOR = vectorOf(svc.dims);
  const hashes = new Map(items.map((item) => [item.id, sha256(item.text)]));
  const rows = await sql<{ ref_id: string; text_hash: string; vector: Buffer }[]>`
    SELECT ref_id, text_hash, array_send(vector) AS vector FROM embeddings WHERE kind = 'article' AND model = ${EMBEDDING_MODEL} AND ref_id IN ${sql(items.map((i) => i.id))}`;
  const have = new Map(rows.map((r) => [r.ref_id, r]));
  const missing = items.filter((i) => {
    const h = have.get(i.id);
    const vector = h && h.text_hash === hashes.get(i.id) ? storedVector(h.vector) : null;
    if (vector && VECTOR.safeParse(vector).success) {
      out.set(i.id, vector);
      return false;
    }
    return true;
  });
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    const { vectors, receiptId } = await embedBatch(batch.map((b) => b.text.slice(0, 2000)), `article:${batch[0]!.id}`);
    await sql.begin(async (tx) => {
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const v = vectors[j]!;
        await tx`INSERT INTO embeddings (kind, ref_id, model, text_hash, vector) VALUES ('article', ${item.id}, ${EMBEDDING_MODEL}, ${hashes.get(item.id)!}, ${v})
                 ON CONFLICT (kind, ref_id, model) DO UPDATE SET text_hash = EXCLUDED.text_hash, vector = EXCLUDED.vector, created_at = now()`;
      }
      await completeReceipt(tx, receiptId);
    });
    for (let j = 0; j < batch.length; j++) out.set(batch[j]!.id, vectors[j]!);
  }
  return out;
}

/** The admin's connectivity check: one short text through the service in use, recorded as a check (not an outage). */
export async function testEmbedding(): Promise<{ ok: boolean; ms: number; dims: number | null; error: string | null }> {
  const started = Date.now();
  try {
    const { vectors } = await embedBatch([`connectivity check ${started}`], `check:embedding:${started}`, "model_check");
    return { ok: true, ms: Date.now() - started, dims: vectors[0]?.length ?? null, error: null };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, dims: null, error: String((error as Error).message).slice(0, 400) };
  }
}
