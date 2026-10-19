// The admin's run switches pause and resume collection and model calls beneath the environment's valves: a paused
// model call waits like a full budget window (never a failure), and the admin cannot turn on what the environment does not allow.
import { gate, pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { collectionOn, modelCallsOn, ModelCallsPaused, runSwitchStatus, setRunSwitch } from "@aihot/backend/operations/switches";
import { saveProvider } from "@aihot/backend/admin/model-providers";

after(closeDb);

const answer = () => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const ask = (model: string, subject: string) => chatJson({ model, purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

test("paused model calls wait without reaching the provider; resumed ones run; the environment still decides", async () => {
  const provider = await stub(answer);
  pointModels(provider.url, ["deepseek-flash"]);
  try {
    await setRunSwitch("models", false, "pause for the test", "test");
    assert.equal(await modelCallsOn(), false);
    await assert.rejects(ask("deepseek-flash", `paused-${tag()}`), (e: Error) => e instanceof ModelCallsPaused && e instanceof BudgetExceededError);
    assert.equal(provider.hits(), 0, "nothing was sent");
    assert.deepEqual((await runSwitchStatus()).find((s) => s.name === "models"), { name: "models", allowed: true, on: false, running: false });

    await setRunSwitch("models", true, "resume", "test");
    assert.equal((await ask("deepseek-flash", `resumed-${tag()}`)).data.ok, true);
    assert.equal(provider.hits(), 1);

    config.modelCallsEnabled = false;
    try {
      await assert.rejects(setRunSwitch("models", true, "cannot", "test"), (e: Error & { statusCode?: number }) => e.statusCode === 400 && /MODEL_CALLS_ENABLED/.test(e.message));
      assert.equal(await modelCallsOn(), false);
    } finally {
      config.modelCallsEnabled = true;
    }
    await assert.rejects(setRunSwitch("models", false, " ", "test"), /reason/);
    const audited = await sql<{ before: unknown; after: unknown }[]>`SELECT before, after FROM audit_log WHERE action = 'ops.switch' AND subject = 'switch:models' ORDER BY id`;
    assert.deepEqual(audited.map((a) => a.after), [{ on: false }, { on: true }]);
  } finally {
    await provider.close();
  }
});

test("collection pauses and resumes, and needs COLLECT_ENABLED", async () => {
  assert.equal(await collectionOn(), true);
  await setRunSwitch("collect", false, "pause", "test");
  assert.equal(await collectionOn(), false);
  await setRunSwitch("collect", true, "resume", "test");
  assert.equal(await collectionOn(), true);
  const env = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "false";
  try {
    assert.equal(await collectionOn(), false);
    await assert.rejects(setRunSwitch("collect", true, "cannot", "test"), /COLLECT_ENABLED/);
  } finally {
    process.env.COLLECT_ENABLED = env;
  }
});

test("a provider's concurrency limit holds extra calls back until a slot frees, instead of the provider refusing them", async () => {
  const hold = gate();
  let inFlight = 0;
  let most = 0;
  const provider = await stub(async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await hold.promise;
    inFlight--;
    return answer();
  });
  const key = `limit-${tag().replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  try {
    await saveProvider(key, { label: "限并发", model: "m", baseUrl: `${provider.url}/v1`, apiKey: "sk-test-concurrency-0123456789", maxConcurrency: 1 }, "add", "test");
    const calls = [ask(key, `c1-${tag()}`), ask(key, `c2-${tag()}`), ask(key, `c3-${tag()}`)];
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(provider.hits(), 1, "only one call is at the provider");
    hold.open();
    assert.deepEqual((await Promise.all(calls)).map((r) => r.data.ok), [true, true, true]);
    assert.equal(most, 1);
    assert.equal(provider.hits(), 3);
  } finally {
    hold.open();
    await provider.close();
  }
});
