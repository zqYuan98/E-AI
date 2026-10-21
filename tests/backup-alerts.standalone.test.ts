import assert from "node:assert/strict";
import { test } from "node:test";
import { isolated, syntheticStore } from "./backup-fixtures.ts";
import type * as Alerts from "../packages/backend/src/operations/alerts.ts";

const success = "2026-11-01T04:00:00.000Z", failure = "2026-11-02T04:00:00.000Z";
async function findings(options: { summary?: object; lastOk?: string | null; lastFailed?: string | null; now?: string } = {}) {
  syntheticStore();
  const sql = async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("key = 'backup.last'")) return options.summary === undefined ? [{ value: { at: success, local: true, uploaded: false } }] : options.summary === null ? [] : [{ value: options.summary }];
    if (query.includes("job = 'ops.backup'")) return [{ last_ok: options.lastOk === null ? null : new Date(options.lastOk ?? success), last_failed: options.lastFailed === null ? null : new Date(options.lastFailed ?? failure), first_attempt: new Date(success) }];
    if (query.includes("FROM deliveries d JOIN")) return [{ n: 0 }];
    if (query.includes("AS receipts,")) return [{ receipts: 0, deliveries: 0 }];
    return [];
  };
  const unexpected = () => { throw new Error("standalone must not send notifications, inspect credentials or call providers"); };
  const alerts = await isolated<typeof Alerts>("../packages/backend/src/operations/alerts.ts", {
    "@aihot/contracts/time": { addDays: unexpected, beijingAt: unexpected, beijingDate: unexpected, beijingDay: unexpected, isValidDate: unexpected, beijingStamp: (value: string | number | Date) => new Date(value).toISOString() },
    "@aihot/site": { ALERTS: { quietMinutes: 60 }, EDITION_TIMES: { daily: "08:00" } },
    "../audit.ts": { audit: unexpected },
    "../db.ts": { sql },
    "../notify/agent.ts": { agentHandoffs: async () => [], closeAgentWake: unexpected, wakeAgent: unexpected },
    "../notify/feishu.ts": { duration: (ms: number) => `${ms / 3600000}h`, sendAlert: unexpected, formatAlert: unexpected, formatRecovery: unexpected },
    "../editorial/models.ts": { stepsOnService: unexpected },
    "./backup.ts": { backupConfigured: unexpected },
    // Collection and model calls read as off, as in the environment of these tests.
    "./switches.ts": { collectionOn: async () => false, runSwitches: async () => ({ collect: false, models: false }) },
    "./grouping.ts": { GROUPING_WARN_AFTER_MS: 600000, waitingSelectedNews: unexpected },
    "../media/upstream.ts": { upstreamFindings: async () => [] },
    "../modules.ts": { remoteBackupDenied: () => true, serverModules: () => [] },
    "../providers/receipts.ts": { awaitingRelease: () => "", providerAccessRefused: () => false },
    "../sources/health.ts": { SOURCE_PROBLEMS: [], sourceHealth: unexpected },
  });
  return (await alerts.collectFindings(Date.parse(options.now ?? "2026-11-02T04:01:00Z"))).filter(finding => finding.key.startsWith("backup."));
}

test("latest failure names the failed run time, separately from the earlier successful snapshot", async () => {
  const [found] = await findings();
  assert.equal(found!.key, "backup.stale");
  assert.match(found!.detail!, new RegExp(`最近一次失败 ${failure.replaceAll(".", "\.")}`));
  assert.ok(found!.detail!.includes(`最近一次成功 ${success}`));
});

test("a failed first attempt reports its failure timestamp even without backup.last", async () => {
  const [found] = await findings({ summary: null as never, lastOk: null });
  assert.ok(found!.detail!.includes(`最近一次失败 ${failure}`));
  assert.ok(found!.detail!.includes("尚无成功备份"));
});

test("a recent local success in deny mode does not need an upload or cloud configuration", async () => {
  assert.deepEqual(await findings({ summary: { at: failure, local: true, uploaded: false }, lastOk: failure, lastFailed: success }), []);
});

test("retention failures are visible without relabelling a completed local snapshot as incomplete", async () => {
  const [found] = await findings({ summary: { at: failure, local: true, uploaded: false, retentionError: "synthetic EACCES" }, lastFailed: "2026-11-02T04:00:30Z" });
  assert.ok(found!.detail!.includes("备份已完成，但旧快照清理失败"));
  assert.ok(found!.detail!.includes("2026-11-02T04:00:30.000Z"));
  assert.ok(!found!.detail!.includes("本地备份不完整"));
});

test("repeated failed archives cannot reset the age of the last successful backup", async () => {
  const [found] = await findings({ summary: { at: "2026-11-04T04:00:00Z", local: false, uploaded: false, filesError: "synthetic packing failure" }, now: "2026-11-04T04:01:00Z", lastFailed: "2026-11-04T04:00:30Z" });
  assert.equal(found!.key, "backup.failed");
  assert.equal(found!.since!.toISOString(), success);
  assert.ok(found!.detail!.includes("本地备份不完整"));
});
