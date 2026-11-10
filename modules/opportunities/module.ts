// 投标商机的地址：列表、公告详情、旧的 /tenders 跳转、后台的业务口径与采集状态，以及它们读的接口。
import { defineModule } from "@aihot/contracts/modules";

export const opportunities = defineModule({
  name: "opportunities",
  pages: [
    { path: "opportunities", file: "web/list.tsx" },
    { path: "opportunities/:id", file: "web/detail.tsx" },
    { path: "tenders", file: "web/tenders.tsx" },
  ],
  // The admin layout in apps/web/app/routes.ts has no path prefix.
  adminPages: [{ path: "admin/opportunities", file: "web/admin.tsx" }],
  apiPaths: [/^\/api\/site\/opportunities(?:\/|$)/, /^\/api\/admin\/opportunities(?:\/|$)/],
});
