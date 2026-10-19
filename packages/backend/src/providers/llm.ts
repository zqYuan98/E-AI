// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless the
// site, an environment variable or the admin's model page picks one of the site's named presets
// (site/models.ts) or one of the providers the deployment adds in MODEL_PROVIDERS.
import type { z } from "zod";
import { PRESETS } from "@aihot/site/models";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { parseModelProviders } from "./model-providers.ts";
import { loadStoredProviders } from "./model-store.ts";
import { ModelCallsPaused, modelCallsOn } from "../operations/switches.ts";
import { assertAccepted, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  /** The address itself, for a provider the deployment adds (MODEL_PROVIDERS); presets name an environment variable instead. */
  baseUrl?: string;
  apiKeyEnv: string;
  /** The key itself, for a provider entered on the admin page (opened from the database); others name an environment variable. */
  apiKey?: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  /** Output tokens added to every call's own limit for a reasoning model, which reasons before it answers. */
  reasoningTokens?: number;
  /** Calls in flight at a time in this process; more wait their turn (a provider's concurrency limit). */
  maxConcurrency?: number;
  jsonMode: boolean;
  vision?: boolean;
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

function reasoningTokensFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("LLM_REASONING_TOKENS must be a non-negative integer, e.g. 4000");
  return Number(value);
}

const presets: Record<string, ModelSpec> = Object.fromEntries(Object.entries(PRESETS).map(([key, preset]) => [key, { key, ...preset }]));
/**
 * Why MODEL_PROVIDERS was not used, for the admin's model page. A typo there must not take the site (and its
 * sign-in) down: the error is logged, the providers are left out and steps on them fall back to their defaults.
 */
export let modelProvidersError: string | null = null;
const providers: Record<string, ModelSpec> = (() => {
  try {
    return Object.fromEntries(
      parseModelProviders(credential("models", "MODEL_PROVIDERS"), new Set(Object.keys(presets))).map(({ key, ...p }) => [key, { key, baseUrlEnv: "MODEL_PROVIDERS", ...p }]),
    );
  } catch (error) {
    modelProvidersError = (error as Error).message;
    console.error(JSON.stringify({ level: "error", msg: "MODEL_PROVIDERS ignored", err: modelProvidersError }));
    return {};
  }
})();

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get reasoningTokens() { return reasoningTokensFromEnv(process.env.LLM_REASONING_TOKENS); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // The pack's named presets, each with its own address and key.
  ...presets,
  // Providers the deployment adds without a code change.
  ...providers,
};

/** Keys of the providers entered on the admin page that are in MODELS now. */
const stored = new Set<string>();
let storedAt = 0;
let storedLoading: Promise<void> | null = null;

/**
 * Brings the admin page's providers (database) into MODELS, at most every 30 seconds per process, so a change made
 * in the api reaches the worker within that time. A read that fails keeps what was loaded and retries soon.
 */
export async function refreshStoredModels(force = false): Promise<void> {
  if (!force && Date.now() - storedAt < 30_000) return;
  storedLoading ??= (async () => {
    try {
      const rows = await loadStoredProviders();
      for (const key of stored) delete MODELS[key];
      stored.clear();
      for (const r of rows) {
        if (!r.enabled || !r.apiKey || MODELS[r.key]) continue;
        MODELS[r.key] = {
          key: r.key, service: "llm", model: r.model, baseUrl: r.baseUrl, baseUrlEnv: "model_providers", apiKeyEnv: "model_providers", apiKey: r.apiKey,
          ...(r.extra ? { extra: r.extra } : {}), ...(r.reasoningTokens ? { reasoningTokens: r.reasoningTokens } : {}),
          ...(r.maxConcurrency ? { maxConcurrency: r.maxConcurrency } : {}), jsonMode: r.jsonMode, vision: r.vision,
        };
        stored.add(r.key);
      }
      storedAt = Date.now();
    } catch (error) {
      storedAt = Date.now() - 25_000;
      console.error(JSON.stringify({ level: "error", msg: "model providers not loaded", err: String((error as Error).message).slice(0, 200) }));
    } finally {
      storedLoading = null;
    }
  })();
  await storedLoading;
}

/** The next call reloads the admin page's providers (after a change). */
export const invalidateStoredModels = () => { storedAt = 0; };

/** Keys of the providers that come from MODEL_PROVIDERS (environment), as opposed to the admin page. */
export const envProviderKeys = () => Object.keys(providers);

/** Per-model slots: a provider with a concurrency limit gets at most that many calls at once from this process. */
const slots = new Map<string, { active: number; waiting: Array<() => void> }>();
async function withSlot<T>(key: string, max: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (!max) return fn();
  const s = slots.get(key) ?? { active: 0, waiting: [] };
  slots.set(key, s);
  while (s.active >= max) await new Promise<void>((resolve) => s.waiting.push(resolve));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.waiting.shift()?.();
  }
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

export class ModelOutputError extends Error {
  readonly receiptId: number | null;
  constructor(message: string, receiptId: number | null = null) {
    super(message);
    this.receiptId = receiptId;
  }
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  if (!MODELS[opts.model]) await refreshStoredModels(true); // a provider added on the admin page after this process loaded
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  if (!(await modelCallsOn())) throw new ModelCallsPaused();
  const baseUrl = spec.baseUrl ?? credential("models", spec.baseUrlEnv);
  const apiKey = spec.apiKey ?? credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !spec.model) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.reasoningTokens ?? 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(spec.extra ?? {}),
  };

  const receipt = await withSlot(spec.key, spec.maxConcurrency, () => paidRequest(
    {
      service: spec.service,
      model: spec.model,
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { model: spec.model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, extra: spec.extra ?? null },
      requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens },
      attemptTag: opts.attemptTag,
    },
    async () => {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
      } catch (error) {
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
        throw error;
      }
      const text = await res.text();
      assertAccepted(spec.service, res.status, text);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Expected a response object");
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      return {
        response: { ...json, _latencyMs: Date.now() - started },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: null,
      };
    },
  ));

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer. A reasoning model that
    // reasoned up to the output limit leaves an empty or cut-off answer; say so, and where to give it room.
    const detail = response.choices?.[0]?.finish_reason === "length"
      ? `output token limit reached (finish_reason=length): a reasoning model may have spent it reasoning; give it room with ${spec.key === "default" ? "LLM_REASONING_TOKENS" : `reasoningTokens on preset ${spec.key}`}. ${String(error)}`
      : String(error);
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${detail.slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${detail.slice(0, 300)}`, receipt.receiptId);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}
