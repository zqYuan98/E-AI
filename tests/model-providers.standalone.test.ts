// MODEL_PROVIDERS adds OpenAI-compatible providers without a code change; a wrong value fails loudly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelProviders } from "../packages/backend/src/providers/model-providers.ts";

const sf = { key: "sf-qwen", model: "Qwen/Qwen3-32B", baseUrl: "https://api.siliconflow.cn/v1", apiKeyEnv: "SILICONFLOW_API_KEY" };

test("unset or blank means no extra providers", () => {
  assert.deepEqual(parseModelProviders(undefined), []);
  assert.deepEqual(parseModelProviders("  "), []);
});

test("a provider gets its defaults: the default model service's budget, JSON mode on", () => {
  const [p] = parseModelProviders(JSON.stringify([sf]));
  assert.equal(p!.service, "llm");
  assert.equal(p!.jsonMode, true);
  assert.equal(p!.apiKeyEnv, "SILICONFLOW_API_KEY");
});

test("extra request fields, reasoning room and vision are kept", () => {
  const [p] = parseModelProviders(JSON.stringify([{ ...sf, extra: { enable_thinking: false }, reasoningTokens: 4000, jsonMode: false, vision: true }]));
  assert.deepEqual({ ...p }, { ...sf, service: "llm", extra: { enable_thinking: false }, reasoningTokens: 4000, jsonMode: false, vision: true });
});

test("bad JSON, a key given inline, unknown fields, a non-http address and name clashes are all refused", () => {
  assert.throws(() => parseModelProviders("{not json"), /JSON array/);
  assert.throws(() => parseModelProviders(JSON.stringify([{ ...sf, apiKeyEnv: "sk-live-secret-value" }])), /apiKeyEnv/);
  assert.throws(() => parseModelProviders(JSON.stringify([{ ...sf, apiKey: "sk-x" }])), /MODEL_PROVIDERS/);
  assert.throws(() => parseModelProviders(JSON.stringify([{ ...sf, service: "unbudgeted" }])), /MODEL_PROVIDERS/, "no service without a budget row");
  assert.throws(() => parseModelProviders(JSON.stringify([{ ...sf, baseUrl: "ftp://example.com" }])), /baseUrl/);
  assert.throws(() => parseModelProviders(JSON.stringify([{ ...sf, key: "default" }])), /already a model name/);
  assert.throws(() => parseModelProviders(JSON.stringify([sf, sf])), /already a model name/);
  assert.throws(() => parseModelProviders(JSON.stringify([sf]), new Set(["sf-qwen"])), /already a model name/);
});
