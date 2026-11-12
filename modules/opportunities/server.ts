// 投标商机：国网电子商务平台、电工交易专区的采购/招标公告（自动下载公告文件、把批次拆成具体项目），加上其他招采平台
// （信源里打了“招标”“招标计划”标签的资料），按后台“业务口径”筛出与公司业务对得上的，从公告正文抽出预算、时间、资质业绩要求，
// 推到后台配的钉钉群（各群选自己要的方向和来源，@ 关注这些方向的提醒人），并在 /opportunities 列出。国网的浏览器采集在同一 compose 的内部采集服务里（fetcher/）。
import type { ServerModule } from "@aihot/backend/modules";
import { actorOf } from "@aihot/backend/admin/auth";
import { modelCallsOn, collectionOn } from "@aihot/backend/operations/switches";
import { adminHandler } from "../../apps/api/src/routes/admin-auth.ts";
import { DEFAULT_PROFILE, loadProfile, saveProfile } from "./backend/profile.ts";
import { fetcherUrl } from "./backend/fetcher.ts";
import { createGroup, deleteGroup, listGroups, updateGroup } from "./backend/groups.ts";
import { pushDigest, pushEnabled, pushTest } from "./backend/push.ts";
import { discoverCycle, processCycle, requestRun } from "./backend/run.ts";
import { counts, listOpportunities, noticeDetail, recentNotices, retention, retryNotice } from "./backend/store.ts";
import type { OpportunityAdmin } from "./types.ts";

const bodyOf = (req: { body: unknown }) => (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
const groupId = (req: { params: unknown }) => Number((req.params as { id: string }).id);

export const opportunities: ServerModule = {
  name: "opportunities",
  models: { opportunities: { label: "投标商机（筛出与公司业务对得上的项目，抽公告要素）", env: "OPPORTUNITIES_MODEL", purposes: ["opportunity_screen", "opportunity_details"] } },
  schedules: [
    { name: "opportunities.discover", cron: "4,24,44 * * * *", run: discoverCycle, missed: "skip", when: () => fetcherUrl() !== null },
    { name: "opportunities.process", cron: "*/5 * * * *", run: processCycle, missed: "skip" },
    { name: "opportunities.digest", cron: "30 8 * * *", run: () => pushDigest(), missed: "skip" },
  ],
  retention: () => retention(),
  http: (app) => {
    app.get("/api/site/opportunities", async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const profile = await loadProfile();
      return listOpportunities({ view: q.view, source: q.source, line: q.line, q: q.q, page: Number(q.page) || 1 }, profile.lines.map((l) => l.name));
    });
    app.get("/api/site/opportunities/:id", async (req, reply) => {
      const detail = await noticeDetail((req.params as { id: string }).id);
      if (!detail) return reply.code(404).send({ error: "not found" });
      return detail;
    });

    app.get("/api/admin/opportunities", adminHandler(async (): Promise<OpportunityAdmin> => ({
      profile: await loadProfile(),
      defaults: DEFAULT_PROFILE,
      status: { fetcherConfigured: fetcherUrl() !== null, pushEnabled: pushEnabled(), collectOn: await collectionOn(), modelOn: await modelCallsOn() },
      groups: await listGroups(),
      notices: await recentNotices(50),
      counts: await counts(),
    })));
    app.post("/api/admin/opportunities/profile", adminHandler(async (req, _reply, admin) => {
      const b = bodyOf(req);
      return { profile: await saveProfile({ lines: b.lines, exclude: b.exclude }, String(b.reason ?? ""), actorOf(admin)) };
    }));
    app.post("/api/admin/opportunities/run", adminHandler(async (req, _reply, admin) => {
      await requestRun(String(bodyOf(req).reason ?? ""), actorOf(admin));
      return { ok: true, message: "已记下，5 分钟内开始采集一轮" };
    }));
    app.post("/api/admin/opportunities/groups", adminHandler(async (req, _reply, admin) => {
      const b = bodyOf(req);
      await createGroup(b, String(b.reason ?? ""), actorOf(admin));
      return { ok: true };
    }));
    app.post("/api/admin/opportunities/groups/:id", adminHandler(async (req, _reply, admin) => {
      const b = bodyOf(req);
      await updateGroup(groupId(req), b, String(b.reason ?? ""), actorOf(admin));
      return { ok: true };
    }));
    app.post("/api/admin/opportunities/groups/:id/delete", adminHandler(async (req, _reply, admin) => {
      await deleteGroup(groupId(req), String(bodyOf(req).reason ?? ""), actorOf(admin));
      return { ok: true };
    }));
    app.post("/api/admin/opportunities/groups/:id/test", adminHandler(async (req) => {
      await pushTest(groupId(req));
      return { ok: true };
    }));
    app.post("/api/admin/opportunities/:id/retry", adminHandler(async (req) => {
      const ok = await retryNotice((req.params as { id: string }).id);
      if (!ok) throw Object.assign(new Error("这条公告现在不需要重新抓取"), { statusCode: 400 });
      return { ok: true };
    }));
  },
};
