// 访问统计：成员每打开一个页面，浏览器报一次到（POST /api/site/visit），记下谁、哪一页、什么时候；管理员自己不计入。
// 后台“访问统计”按天、按成员、按页面看，也可以导出明细。个人明细保留 180 天，之后只留每天的总量。
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerModule } from "@aihot/backend/modules";
import { actorOf } from "@aihot/backend/admin/auth";
import { audit } from "@aihot/backend/audit";
import { siteAccess } from "@aihot/contracts/access";
import { MODULES } from "@aihot/site/modules";
import { adminHandler } from "../../apps/api/src/routes/admin-auth.ts";
import { allowVisit, deviceOf, parseVisit } from "./backend/visit.ts";
import { exportVisits, recordVisit, rollUpOldVisits, usageReport } from "./backend/store.ts";

/** 这个请求背后的成员；不是成员（管理员、没有会话）、或站点没有成员登录，返回 null。向访问模块的会话接口问，不碰它的代码和表。 */
async function memberOf(app: FastifyInstance, req: FastifyRequest): Promise<{ id: number; name: string } | null> {
  const sessionPath = siteAccess(MODULES)?.sessionPath;
  if (!sessionPath) return null;
  const session = await app.inject({ method: "GET", url: sessionPath, headers: { cookie: req.headers.cookie ?? "" } });
  if (session.statusCode !== 200) return null;
  const principal = session.json() as { id?: unknown; kind?: unknown; name?: unknown };
  const id = typeof principal.id === "string" ? Number(principal.id.split(":")[1]) : NaN;
  return principal.kind === "member" && Number.isInteger(id) && typeof principal.name === "string" ? { id, name: principal.name } : null;
}

export const usage: ServerModule = {
  name: "usage",
  http: (app) => {
    // 访问模块的守卫已经认过会话、来源和 CSRF 令牌，这里只管记。报到失败不影响读者看页面，所以不记的情况都回 204。
    app.post("/api/site/visit", { bodyLimit: 2 * 1024 }, async (req, reply) => {
      const visit = parseVisit(req.body);
      if (!visit) return reply.code(400).send({ error: "invalid visit" });
      const member = await memberOf(app, req);
      if (member && allowVisit(member.id)) await recordVisit(member, { ...visit, device: deviceOf(req.headers["user-agent"]) });
      return reply.code(204).send();
    });

    app.get("/api/admin/usage", adminHandler(async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return usageReport({ range: Number(q.range), day: q.day, member: q.member === undefined ? undefined : Number(q.member) });
    }));
    app.get("/api/admin/usage/export", adminHandler(async (req, reply, admin) => {
      const q = req.query as Record<string, string | undefined>;
      const { csv, rows, from, to } = await exportVisits(q.from, q.to);
      // 导出的是带姓名的个人访问记录，留一条审计。
      await audit(actorOf(admin), "usage.export", "usage:export", null, null, { from, to, rows });
      return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="usage-${from}_${to}.csv"`).send(csv);
    }));
  },
  retention: rollUpOldVisits,
};
