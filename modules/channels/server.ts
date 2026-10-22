// 频道：招标商机、政策动态、行业热点。页面读引擎的“全部动态”接口；这里只给出每个频道现在的标题、介绍、筛选项和自动话题，
// 以及后台“频道设置”改这些的接口。
import type { ServerModule } from "@aihot/backend/modules";
import { actorOf } from "@aihot/backend/admin/auth";
import { adminHandler } from "../../apps/api/src/routes/admin-auth.ts";
import { channelsAdmin, channelView, isChannelKey, resetChannel, saveChannel } from "./backend/settings.ts";

const keyOf = (req: { params: unknown }) => {
  const key = (req.params as { key: string }).key;
  if (!isChannelKey(key)) throw Object.assign(new Error("no such channel"), { statusCode: 404 });
  return key;
};
const bodyOf = (req: { body: unknown }) => (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

export const channels: ServerModule = {
  name: "channels",
  http: (app) => {
    app.get("/api/site/channels/:key", async (req, reply) => {
      reply.header("cache-control", "public, max-age=60, s-maxage=60");
      return channelView(keyOf(req));
    });

    app.get("/api/admin/channels", adminHandler(async () => channelsAdmin()));
    app.post("/api/admin/channels/:key", { bodyLimit: 64 * 1024 }, adminHandler(async (req, _reply, admin) => {
      const b = bodyOf(req);
      return saveChannel(keyOf(req), b.text, String(b.reason ?? ""), actorOf(admin));
    }));
    app.post("/api/admin/channels/:key/reset", adminHandler(async (req, _reply, admin) => resetChannel(keyOf(req), String(bodyOf(req).reason ?? ""), actorOf(admin))));
  },
};
