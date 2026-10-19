// 政策规划库的地址：列表页、详情页，以及它们读的接口。
import { defineModule } from "@aihot/contracts/modules";

export const policy = defineModule({
  name: "policy",
  pages: [
    { path: "policy", file: "web/list.tsx" },
    { path: "policy/:id", file: "web/detail.tsx" },
  ],
  // The admin layout in apps/web/app/routes.ts has no path prefix.
  adminPages: [{ path: "admin/policy", file: "web/admin.tsx" }],
  apiPaths: [/^\/api\/site\/policy(?:\/|$)/, /^\/api\/admin\/policy(?:\/|$)/],
});
