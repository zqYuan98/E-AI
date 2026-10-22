// 频道的地址：招标商机、政策动态、行业热点三页（共用 web/channel.tsx，条目读引擎的“全部动态”接口），
// 每个频道的设置和自动话题（/api/site/channels），以及后台“频道设置”。
import { defineModule } from "@aihot/contracts/modules";

export const channels = defineModule({
  name: "channels",
  pages: [
    { path: "tenders", file: "web/tenders.tsx" },
    { path: "policy-news", file: "web/policy-news.tsx" },
    { path: "trends", file: "web/trends.tsx" },
  ],
  // The admin layout in apps/web/app/routes.ts has no path prefix.
  adminPages: [{ path: "admin/channels", file: "web/admin.tsx" }],
  apiPaths: [/^\/api\/site\/channels(?:\/|$)/, /^\/api\/admin\/channels(?:\/|$)/],
});
