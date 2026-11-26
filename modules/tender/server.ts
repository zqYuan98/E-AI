// 招采申报：从招采类资料的原文里认出投标截止、报名截止、金额、采购人、中标人、地区和公告阶段（backend/extract.ts，
// 字段词表借鉴开源项目「招投标大师」），给出按截止时间排好的列表页（/procurement）和条目页上的“标讯要素”。
// 定时任务只读库里已有的正文，不联网、不调模型；页面只读认好的结果。
import type { ServerModule } from "@aihot/backend/modules";
import { extractPending } from "./backend/store.ts";
import { listTenders, tenderFactsFor } from "./backend/read.ts";

export const tender: ServerModule = {
  name: "tender",
  schedules: [{ name: "tender.extract", cron: "*/2 * * * *", run: () => extractPending(), missed: "skip" }],
  item: (articleId) => tenderFactsFor(articleId),
  http: (app) => {
    app.get("/api/site/procurement", async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      // Countdowns move: a minute at most.
      reply.header("cache-control", "public, max-age=60, s-maxage=60");
      return listTenders({ view: q.view, region: q.region, q: q.q, past: q.past });
    });
  },
};
