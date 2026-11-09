// 访问统计的地址：后台“访问统计”页，以及成员浏览器报到用的接口和后台读的接口。
import { defineModule } from "@aihot/contracts/modules";

export const usage = defineModule({
  name: "usage",
  // The admin layout in apps/web/app/routes.ts has no path prefix.
  adminPages: [{ path: "admin/usage", file: "web/admin.tsx" }],
  apiPaths: [/^\/api\/site\/visit$/, /^\/api\/admin\/usage(?:\/|$)/],
});
