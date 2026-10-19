// The embeddings service entered on the admin settings page: its key is sealed and never listed, grouping uses it when the
// environment has no service of its own, and an environment key still wins.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { embeddingSettings, saveEmbedding } from "@aihot/backend/admin/embedding";
import { embeddingService, embeddingsAvailable, ensureEmbeddings, invalidateEmbeddingService, testEmbedding } from "@aihot/backend/providers/embeddings";

after(closeDb);

const KEY = `sk-embed-${tag()}-0123456789`;

test("a service saved on the page is sealed, used for embeddings and checked, but the environment's key wins", async () => {
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  const seen: Array<{ model: string; auth: string }> = [];
  const provider = await stub((_hit, req) => {
    const body = JSON.parse(req.body) as { model: string; input: string[] };
    seen.push({ model: body.model, auth: "" });
    return { data: body.input.map((_t, index) => ({ index, embedding: [index + 1, 0.5, 0.25] })), usage: { prompt_tokens: 1 } };
  });
  try {
    assert.equal(await embeddingService(), null);
    assert.equal(await embeddingsAvailable(), false);
    await assert.rejects(saveEmbedding({ baseUrl: `${provider.url}/v1`, model: "embed-a", dims: 0 }, "first", "test"), /apiKey/);
    await saveEmbedding({ baseUrl: `${provider.url}/v1`, model: "embed-a", dims: 0, apiKey: KEY }, "first", "test");

    const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'embedding.service'`;
    assert.equal(JSON.stringify(row!.value).includes(KEY), false, "only ciphertext is stored");
    const page = await embeddingSettings();
    assert.equal(JSON.stringify(page).includes(KEY), false, "the page never gets the key");
    assert.deepEqual({ source: page.inUse?.source, model: page.inUse?.model, hint: page.stored?.keyHint }, { source: "admin", model: "embed-a", hint: `…${KEY.slice(-4)}` });
    assert.equal(await embeddingsAvailable(), true);

    const id = `embed-admin-${tag()}`;
    const vectors = await ensureEmbeddings([{ id, text: "国网发布电力大模型" }]);
    assert.equal(vectors.get(id)?.length, 3);
    assert.equal(seen.at(-1)!.model, "embed-a");
    assert.equal((await testEmbedding()).ok, true);
    const checks = await sql`SELECT 1 FROM receipts WHERE purpose = 'model_check' AND service = 'embedding'`;
    assert.equal(checks.length, 1, "a check is recorded as a check");

    // An edit without a key keeps it; stopping it leaves no service.
    await saveEmbedding({ baseUrl: `${provider.url}/v1`, model: "embed-b", dims: 0, enabled: false }, "stop", "test");
    assert.equal(await embeddingService(), null);
    await saveEmbedding({ baseUrl: `${provider.url}/v1`, model: "embed-b", dims: 0 }, "start", "test");
    assert.equal((await embeddingService())?.model, "embed-b");

    process.env.DASHSCOPE_API_KEY = "test-key";
    invalidateEmbeddingService();
    assert.equal((await embeddingService())?.source, "env", "the deployment's key decides");
    const audited = await sql<{ after: unknown }[]>`SELECT after FROM audit_log WHERE action = 'settings.embedding'`;
    assert.equal(audited.length, 3);
    assert.equal(JSON.stringify(audited).includes(KEY), false);
  } finally {
    delete process.env.DASHSCOPE_API_KEY;
    await provider.close();
  }
});
