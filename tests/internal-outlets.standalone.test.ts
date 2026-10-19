// Real policy, submission and scheduler code, with all I/O dependencies replaced in memory.
// No config/credentials/database/provider module is loaded and fetch never reaches the network.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, mock } from "node:test";
import type { PgBoss } from "pg-boss";
import { indexSubmissionDenied, installModules, remoteBackupDenied, serverModules } from "../packages/backend/src/modules.ts";

const now = new Date("2026-10-16T06:00:00Z");
const state = {
  queries: [] as string[], links: [] as string[], topics: 0, queues: [] as string[],
  config: { indexNowSubmitEnabled: true, indexNowKey: "0123456789abcdef0123456789abcdef", siteUrl: "https://internal-fixture.invalid" },
  sql: Object.assign(async (parts: TemplateStringsArray) => {
    const query = parts.join("?");
    state.queries.push(query);
    if (query.includes("SELECT kind, key")) return [{ kind: "daily", key: "2026-10-16" }];
    if (query.includes("SELECT article_id AS id")) return [{ id: "fixture-item", updated_at: now }];
    return [];
  }, { json: (value: unknown) => value }),
};
const key = Symbol.for("internal-outlets-fixture");
(globalThis as unknown as Record<symbol, unknown>)[key] = state;
const shared = 'const s = globalThis[Symbol.for("internal-outlets-fixture")];';
const data = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const modulesUrl = new URL("../packages/backend/src/modules.ts", import.meta.url).href;
const indexUrl = new URL("../packages/backend/src/operations/indexnow.ts", import.meta.url).href;
const accessUrl = new URL("../modules/access/server.ts", import.meta.url).href;
const scheduleUrl = new URL("../apps/worker/src/schedules.ts", import.meta.url).href;
const stubs: Record<string, string> = {
  "@aihot/backend/jobs/queue": `${shared} export const ensureQueue = async (name) => { s.queues.push(name); }; export const recordRun = async (_, run) => run();`,
  "@aihot/backend/jobs/content": "export const sweepUnprocessed = async () => {};",
  "@aihot/backend/editorial/translate": "export const translatePending = async () => {};",
  "@aihot/backend/sources/collect": "export const adaptIntervals = async () => {}; export const scheduleDueSources = async () => {};",
  "@aihot/backend/sources/mp": "export const scheduleMpReconcile = async () => {};",
  "@aihot/backend/providers/dajiala": "export const dajialaConfigured = () => false;",
  "@aihot/backend/sources/icons": "export const refreshSourceIcons = async () => {};",
  "@aihot/backend/events/hot": "export const computeHotRanking = async () => {}; export const snapshotHeat = async () => {};",
  "@aihot/backend/events/consolidate": "export const linkRelatedStories = async () => {};",
  "@aihot/backend/reports/compose": "export const composeDueReports = async () => {};",
  "@aihot/backend/operations/retention": "export const dailyRetention = async () => {};",
  "@aihot/backend/operations/alerts": "export const checkAlerts = async () => {}; export const sendDigest = async () => {};",
  "@aihot/backend/operations/recover": "export const recoverStaleWork = async () => {};",
  "@aihot/backend/operations/feedback": "export const forwardPendingFeedback = async () => {};",
  "@aihot/backend/operations/backup": "export const backupConfigured = () => false; export const runBackup = async () => {};",
  "@aihot/backend/operations/reports": "export const sourceHealthWeekly = async () => {};",
  "@aihot/backend/operations/switches": "export const collectionOn = async () => false;",
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    let source: string | undefined;
    if (context.parentURL === indexUrl) {
      if (specifier === "../config.ts") source = `${shared} export const config = s.config;`;
      if (specifier === "../db.ts") source = `${shared} export const sql = s.sql;`;
      if (specifier === "../publication/links.ts") source = `${shared} export const siteUrl = (path) => { s.links.push(path); return s.config.siteUrl + path; };`;
      if (specifier === "../publication/scope.ts") source = "export const evidenceCondition = () => ''; export const listedCondition = () => '';";
      if (specifier === "../publication/topics.ts") source = `${shared} export const topicPageCounts = async () => { s.topics++; return [{ indexable: true, slug: 'fixture-topic', changedAt: new Date('2026-10-16T05:00:00Z') }]; };`;
    }
    if (context.parentURL === accessUrl) {
      if (specifier === "@aihot/backend/db") source = `${shared} export const sql = s.sql;`;
      if (specifier === "./backend/guard.ts") source = "export const registerAccessGuard = () => {};";
      if (specifier === "./backend/routes.ts") source = "export const registerAccess = () => {};";
    }
    if (context.parentURL === scheduleUrl) {
      if (specifier === "@aihot/backend/modules") return { url: modulesUrl, shortCircuit: true };
      if (specifier === "@aihot/backend/operations/indexnow") return { url: indexUrl, shortCircuit: true };
      source = stubs[specifier];
      if (!source) throw new Error("Unmocked scheduler dependency");
    }
    return source ? { url: data(source), shortCircuit: true } : next(specifier, context);
  },
});
const original = serverModules();
const fetched: Array<{ url: string; body: unknown }> = [];
const network = mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  fetched.push({ url: String(input), body: JSON.parse(String(init?.body)) });
  return new Response(null, { status: 200 });
});
const { access } = await import("../modules/access/server.ts");
const { submitIndexNow } = await import("../packages/backend/src/operations/indexnow.ts");
const { registerSchedules } = await import("../apps/worker/src/schedules.ts");
after(() => { installModules(original); network.mock.restore(); hook.deregister(); delete (globalThis as unknown as Record<symbol, unknown>)[key]; });

function reset() { state.queries.length = 0; state.links.length = 0; state.topics = 0; state.queues.length = 0; fetched.length = 0; }

test("index submission defaults to allowed, one veto wins and backup policy is independent", () => {
  installModules([]);
  assert.equal(indexSubmissionDenied(), false);
  installModules([{ name: "backup-only", backup: { remote: "deny" } }]);
  assert.equal(indexSubmissionDenied(), false);
  installModules([{ name: "index-only", indexing: { submit: "deny" } }]);
  assert.equal(indexSubmissionDenied(), true);
  assert.equal(remoteBackupDenied(), false);
  for (const list of [[{ name: "public" }, access], [access, { name: "public" }]]) {
    installModules(list);
    assert.equal(indexSubmissionDenied(), true);
  }
});

test("internal submission denies before reads, URL construction and fetch, despite key, switch and eligible URLs", async () => {
  reset(); installModules([access]);
  assert.match(state.config.indexNowKey, /^[0-9a-f]{32}$/);
  assert.equal(state.config.indexNowSubmitEnabled, true);
  assert.deepEqual(await submitIndexNow(now), { status: "denied", httpStatus: null, urls: 0, more: false, sample: [] });
  assert.equal(state.queries.length, 0);
  assert.equal(state.links.length, 0);
  assert.equal(state.topics, 0);
  assert.equal(fetched.length, 0);
});

test("public submission still computes and submits eligible URLs using the same key and switch", async () => {
  reset(); installModules([]);
  const out = await submitIndexNow(now);
  assert.equal(out.status, "sent");
  assert.equal(out.urls, 3);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "https://api.indexnow.org/indexnow");
  const body = fetched[0].body as { key: string; urlList: string[] };
  assert.equal(body.key, state.config.indexNowKey);
  assert.equal(body.urlList.length, 3);
  assert.equal(state.queries.filter((q) => q.includes("INSERT INTO settings")).length, 1);
});

test("installing access retires an old IndexNow cron execution queue through registerSchedules", async () => {
  reset(); installModules([]);
  const queues = new Set(["cron.seo.indexnow", "business.keep"]);
  const scheduled: string[] = [], deleted: string[] = [];
  const boss = {
    schedule: async (name: string) => { queues.add(name); scheduled.push(name); },
    work: async () => {},
    getQueues: async () => [...queues].map((name) => ({ name })),
    deleteQueue: async (name: string) => { deleted.push(name); queues.delete(name); },
  } as unknown as PgBoss;
  await registerSchedules(boss);
  assert.ok(scheduled.includes("cron.seo.indexnow"));
  scheduled.length = 0; state.queues.length = 0;
  installModules([access]);
  await registerSchedules(boss);
  assert.ok(!scheduled.includes("cron.seo.indexnow"));
  assert.ok(!state.queues.includes("cron.seo.indexnow"));
  assert.ok(deleted.includes("cron.seo.indexnow"));
  assert.ok(!queues.has("cron.seo.indexnow"));
  assert.ok(queues.has("business.keep"));
  assert.equal(fetched.length, 0);
});
