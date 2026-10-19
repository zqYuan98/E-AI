// 研报库的地址：列表页、详情页、后台管理页，以及它们读的接口。
import { defineModule } from "@aihot/contracts/modules";

export const research = defineModule({
  name: "research",
  pages: [
    { path: "research", file: "web/list.tsx" },
    { path: "research/:id", file: "web/detail.tsx" },
  ],
  // The admin layout in apps/web/app/routes.ts has no path prefix.
  adminPages: [{ path: "admin/research", file: "web/admin.tsx" }],
  apiPaths: [/^\/api\/site\/research(?:\/|$)/, /^\/api\/admin\/research(?:\/|$)/],
});
