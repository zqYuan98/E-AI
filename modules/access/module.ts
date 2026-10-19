import { defineModule } from "@aihot/contracts/modules";

export const access = defineModule({
  name: "access",
  pages: [{ path: "login", file: "web/login.tsx" }, { path: "account", file: "web/account.tsx" }],
  // The admin layout in apps/web/app/routes.ts has no path prefix.
  adminPages: [{ path: "admin/access", file: "web/admin.tsx" }],
  apiPaths: [/^\/api\/access(?:\/|$)/, /^\/api\/admin\/access(?:\/|$)/],
  access: { loginPath: "/login", sessionPath: "/api/access/session" },
});
