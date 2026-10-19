// Models a deployment adds itself: MODEL_PROVIDERS is a JSON array of OpenAI-compatible providers, each
// becoming a named model next to the site's presets (site/models.ts). The API key is never in the JSON:
// `apiKeyEnv` names the variable that holds it (.env, or the models credential file). They all share the
// default model service's budget and alerts (`llm`), so none of them runs without a circuit breaker.
import { z } from "zod";

const Provider = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,48}$/, "key: 2–49 lowercase letters, digits, . _ -"),
  model: z.string().min(1).max(200),
  baseUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), "baseUrl must be http(s)"),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "apiKeyEnv: the variable's name, e.g. SILICONFLOW_API_KEY"),
  extra: z.record(z.string(), z.unknown()).optional(),
  reasoningTokens: z.number().int().min(0).max(100_000).optional(),
  jsonMode: z.boolean().default(true),
  vision: z.boolean().optional(),
}).strict();

export interface CustomProvider {
  key: string;
  service: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  extra?: Record<string, unknown>;
  reasoningTokens?: number;
  jsonMode: boolean;
  vision?: boolean;
}

/** Parses MODEL_PROVIDERS; a wrong value throws with the reason (llm.ts logs it and loads none of them), never drops one quietly. */
export function parseModelProviders(raw: string | null | undefined, taken: ReadonlySet<string> = new Set()): CustomProvider[] {
  if (!raw || !raw.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_PROVIDERS must be a JSON array, e.g. [{\"key\":\"sf-qwen\",\"model\":\"Qwen/Qwen3-32B\",\"baseUrl\":\"https://api.siliconflow.cn/v1\",\"apiKeyEnv\":\"SILICONFLOW_API_KEY\"}]");
  }
  const parsed = z.array(Provider).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`MODEL_PROVIDERS${issue.path.length ? `[${issue.path.join(".")}]` : ""}: ${issue.message}`);
  }
  const seen = new Set<string>();
  for (const p of parsed.data) {
    if (p.key === "default" || taken.has(p.key) || seen.has(p.key)) throw new Error(`MODEL_PROVIDERS: key "${p.key}" is already a model name`);
    seen.add(p.key);
  }
  return parsed.data.map((p) => ({ ...p, service: "llm" }));
}
