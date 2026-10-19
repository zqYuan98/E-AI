// 研报库：研究机构的研报，每篇一行（标题、机构、日期、摘要、带原话的要点、原文链接）。内容由管理员在后台导入，
// 页面只读；不进对外的 API、MCP 和 RSS（研报是付费会员内容，只在内部站点里看）。
import type { ServerModule } from "@aihot/backend/modules";
import { actorOf } from "@aihot/backend/admin/auth";
import { adminHandler } from "../../apps/api/src/routes/admin-auth.ts";
import { deleteReport, importReports, listReports, loadReport, researchAdmin, setReportHidden } from "./backend/store.ts";

const idOf = (req: { params: unknown }) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("invalid id"), { statusCode: 400 });
  return id;
};
const bodyOf = (req: { body: unknown }) => (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

export const research: ServerModule = {
  name: "research",
  http: (app) => {
    app.get("/api/site/research", async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return listReports({ q: q.q, topic: q.topic });
    });
    app.get("/api/site/research/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const report = Number.isInteger(id) && id > 0 ? await loadReport(id) : null;
      if (!report) return reply.code(404).send({ error: "not found" });
      return report;
    });

    app.get("/api/admin/research", adminHandler(async () => researchAdmin()));
    app.post("/api/admin/research/import", { bodyLimit: 2 * 1024 * 1024 }, adminHandler(async (req, _reply, admin) => importReports(bodyOf(req).reports, actorOf(admin))));
    app.post("/api/admin/research/:id/hidden", adminHandler(async (req, _reply, admin) => {
      const b = bodyOf(req);
      return setReportHidden(idOf(req), b.hidden === true, String(b.reason ?? ""), actorOf(admin));
    }));
    app.post("/api/admin/research/:id/delete", adminHandler(async (req, _reply, admin) => deleteReport(idOf(req), String(bodyOf(req).reason ?? ""), actorOf(admin))));
  },
};
