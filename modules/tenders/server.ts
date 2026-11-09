// 招采公告抽取：把招采信源的资料交给模型抽取要素（关键时间、标包、资格要求），给天枢商务投标助手增量拉取。
// 抽取由定时任务做（backend/extract.ts），天枢通过带令牌的内部接口读（backend/feed.ts），网站页面不受影响。
import type { ServerModule } from "@aihot/backend/modules";
import { extractPending, setWatchKeywords } from "./backend/extract.ts";
import { authorized, FEED_LIMIT, feedPage, feedStatus, feedToken } from "./backend/feed.ts";

export const tenders: ServerModule = {
  name: "tenders",
  models: { tenders: { label: "招采公告解析（公告类型、标包、关键时间、资格要求）", env: "TENDERS_MODEL", purposes: ["tender_extract"] } },
  schedules: [{ name: "tenders.extract", cron: "3,18,33,48 * * * *", run: extractPending, missed: "skip", when: () => feedToken() !== null }],
  http: (app) => {
    // 机器之间的接口：不认会话，只认令牌；令牌没配时和不存在一样。
    app.addHook("onRequest", async (req, reply) => {
      if (!req.routeOptions.url?.startsWith("/api/internal/tenders/")) return;
      reply.header("Cache-Control", "no-store");
      if (!authorized(req)) return reply.code(feedToken() ? 401 : 404).send({ error: feedToken() ? "unauthorized" : "not found" });
    });
    app.get("/api/internal/tenders/feed", async (req) => {
      const q = req.query as { after?: string; limit?: string };
      const after = /^\d{1,18}$/.test(q.after ?? "") ? q.after! : "0";
      const limit = Math.min(Math.max(Number(q.limit) || FEED_LIMIT, 1), FEED_LIMIT);
      return feedPage(after, limit);
    });
    app.put("/api/internal/tenders/watch", async (req) => setWatchKeywords(req.body));
    app.get("/api/internal/tenders/status", async () => feedStatus());
  },
};
