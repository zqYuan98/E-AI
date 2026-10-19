// 政策规划库：国家部委、两网和发电集团的规划、方案、意见等文件，每份一行，要素回原文核对。
// 入库由定时任务做（backend/extract.ts），页面只读库里已有的结果。
import type { ServerModule } from "@aihot/backend/modules";
import { extractPending } from "./backend/extract.ts";
import { listPolicies, loadPolicy } from "./backend/read.ts";

const CACHE = "public, max-age=300, s-maxage=300";

export const policy: ServerModule = {
  name: "policy",
  models: { policy: { label: "政策规划抽取（是否政策规划文件、文号日期、目标指标、重点任务、AI 条款）", env: "POLICY_MODEL", purposes: ["policy_extract"] } },
  schedules: [{ name: "policy.extract", cron: "7,22,37,52 * * * *", run: extractPending, missed: "skip" }],
  http: (app) => {
    app.get("/api/site/policy", async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      reply.header("cache-control", CACHE);
      return listPolicies({ level: q.level, type: q.type, ai: q.ai, q: q.q });
    });
    app.get("/api/site/policy/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const doc = Number.isInteger(id) && id > 0 ? await loadPolicy(id) : null;
      if (!doc) return reply.code(404).send({ error: "not found" });
      reply.header("cache-control", CACHE);
      return doc;
    });
  },
};
