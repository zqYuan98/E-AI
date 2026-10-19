// Providers entered on the admin page: the key is sealed in the database and never listed, the provider joins the
// model registry and is called with its key, a stopped or removed one leaves it, and steps switched to one are
// protected from its removal.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { z } from "zod";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview, switchModel, testModel } from "@aihot/backend/admin/models";
import { deleteProvider, listProviders, saveProvider } from "@aihot/backend/admin/model-providers";
import { modelFor } from "@aihot/backend/editorial/models";
import { chatJson, invalidateStoredModels, MODELS, refreshStoredModels } from "@aihot/backend/providers/llm";

const T = tag().replace(/[^a-z0-9]/gi, "").toLowerCase();
const KEY = `ui-${T}`;
const SECRET_KEY = `sk-test-${T}-0123456789abcdef`;
const input = (url: string, extra: Record<string, unknown> = {}) => ({ label: "测试服务商", model: "vendor/model-a", baseUrl: `${url}/v1`, apiKey: SECRET_KEY, ...extra });
const ask = (model: string, subject: string) => chatJson({ model, purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

after(async () => {
  await sql`DELETE FROM model_providers WHERE key LIKE ${"ui-%"}`;
  await sql`DELETE FROM settings WHERE key LIKE 'models.%'`;
  await closeDb();
});

test("a saved provider is sealed, never listed with its key, and called with it", async () => {
  const seen: Array<{ model: string }> = [];
  const provider = await stub((_hit, req) => { seen.push({ model: JSON.parse(req.body).model }); return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }; });
  try {
    assert.deepEqual(await saveProvider(KEY, input(provider.url), "add for test", "test"), { key: KEY, created: true, keyChanged: true });
    const [row] = await sql<{ api_key_enc: string; api_key_hint: string }[]>`SELECT api_key_enc, api_key_hint FROM model_providers WHERE key = ${KEY}`;
    assert.ok(!row!.api_key_enc.includes(SECRET_KEY) && row!.api_key_enc.startsWith("v1."), "ciphertext only");
    assert.equal(row!.api_key_hint, `…${SECRET_KEY.slice(-4)}`);

    const listed = (await listProviders()).find((p) => p.key === KEY)!;
    assert.equal(JSON.stringify(listed).includes(SECRET_KEY), false, "the list never carries the key");
    assert.equal(JSON.stringify(await modelsOverview(1)).includes(SECRET_KEY), false);
    assert.deepEqual({ source: listed.source, enabled: listed.enabled, keyReadable: listed.keyReadable }, { source: "admin", enabled: true, keyReadable: true });
    assert.ok(MODELS[KEY], "the provider is a model now");

    const result = await ask(KEY, `ui-call-${T}`);
    assert.equal(result.data.ok, true);
    assert.deepEqual(seen, [{ model: "vendor/model-a" }]);
    assert.equal((await testModel(KEY)).ok, true);
    const audited = await sql<{ before: unknown; after: unknown }[]>`SELECT before, after FROM audit_log WHERE subject = ${`provider:${KEY}`}`;
    assert.equal(JSON.stringify(audited).includes(SECRET_KEY), false, "the audit trail has the hint only");
    assert.equal(audited.length, 1);
  } finally {
    await provider.close();
  }
});

test("an edit without a key keeps the saved one; with a key replaces it; bad input and taken names are refused", async () => {
  const [before] = await sql<{ api_key_enc: string }[]>`SELECT api_key_enc FROM model_providers WHERE key = ${KEY}`;
  const { apiKey: _kept, ...withoutKey } = input("http://127.0.0.1:9", { label: "改名", jsonMode: false });
  assert.deepEqual(await saveProvider(KEY, withoutKey, "rename", "test"), { key: KEY, created: false, keyChanged: false });
  const [same] = await sql<{ api_key_enc: string; label: string; json_mode: boolean }[]>`SELECT api_key_enc, label, json_mode FROM model_providers WHERE key = ${KEY}`;
  assert.equal(same!.api_key_enc, before!.api_key_enc);
  assert.deepEqual({ label: same!.label, json: same!.json_mode, spec: MODELS[KEY]!.jsonMode }, { label: "改名", json: false, spec: false });

  assert.equal((await saveProvider(KEY, input("http://127.0.0.1:9", { apiKey: `sk-new-${T}-9876543210` }), "rotate", "test")).keyChanged, true);
  const [rotated] = await sql<{ api_key_enc: string }[]>`SELECT api_key_enc FROM model_providers WHERE key = ${KEY}`;
  assert.notEqual(rotated!.api_key_enc, before!.api_key_enc);

  const refuses = (key: string, body: unknown, reason = "r") => assert.rejects(saveProvider(key, body, reason, "test"), (e: Error & { statusCode?: number }) => e.statusCode === 400);
  await refuses("default", input("http://127.0.0.1:9"));
  await refuses("deepseek-flash", input("http://127.0.0.1:9"));
  await refuses("Bad Key!", input("http://127.0.0.1:9"));
  await refuses(`ui-${T}-new`, { ...input("http://127.0.0.1:9"), apiKey: undefined });
  await refuses(`ui-${T}-new`, { ...input("http://127.0.0.1:9"), apiKey: "short" });
  await refuses(`ui-${T}-new`, { ...input("http://127.0.0.1:9"), baseUrl: "ftp://example.com" });
  await refuses(`ui-${T}-new`, { ...input("http://127.0.0.1:9"), extra2: 1 });
  await refuses(`ui-${T}-new`, input("http://127.0.0.1:9"), " ");
});

test("a stopped provider leaves the registry and steps on it fall back; removal is refused while a step uses it", async () => {
  await refreshStoredModels(true);
  await switchModel("summarize", KEY, "use the new provider", "test");
  assert.equal(await modelFor("summarize"), KEY);
  assert.deepEqual((await listProviders()).find((p) => p.key === KEY)!.usedBy.length, 1);

  await assert.rejects(deleteProvider(KEY, "remove", "test"), (e: Error & { code?: string }) => e.code === "conflict");

  await saveProvider(KEY, { ...input("http://127.0.0.1:9"), apiKey: undefined, enabled: false }, "stop", "test");
  assert.equal(MODELS[KEY], undefined, "a stopped provider is not a model");
  assert.notEqual(await modelFor("summarize"), KEY, "the step falls back to its default");
  assert.ok(await ask(KEY, `ui-stopped-${T}`).then(() => false, (e: Error) => /Unknown model/.test(e.message)));

  await saveProvider(KEY, { ...input("http://127.0.0.1:9"), apiKey: undefined }, "start again", "test");
  assert.ok(MODELS[KEY]);
  await switchModel("summarize", null, "back to the default", "test");
  assert.deepEqual(await deleteProvider(KEY, "remove", "test"), { key: KEY });
  assert.equal(MODELS[KEY], undefined);
  assert.equal((await listProviders()).some((p) => p.key === KEY), false);
});

test("another process picks a new provider up on its next call, and an unreadable key never becomes a model", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const key = `ui-${T}-w`;
  try {
    await saveProvider(key, input(provider.url), "add", "test");
    // Drop this process's copy as a worker that has not reloaded yet would have none.
    delete MODELS[key];
    invalidateStoredModels();
    assert.equal((await ask(key, `ui-worker-${T}`)).data.ok, true, "chatJson loads an unknown name once before refusing it");

    const secret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "another-session-secret-9876543210";
    try {
      await refreshStoredModels(true);
      assert.equal(MODELS[key], undefined, "sealed under another secret: not callable");
      assert.equal((await listProviders()).find((p) => p.key === key)!.keyReadable, false);
    } finally {
      process.env.SESSION_SECRET = secret;
    }
    await refreshStoredModels(true);
    assert.ok(MODELS[key]);
  } finally {
    await provider.close();
  }
});
