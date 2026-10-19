import type { ServerModule } from "@aihot/backend/modules";
import { sql } from "@aihot/backend/db";
import { registerAccessGuard } from "./backend/guard.ts";
import { registerAccess } from "./backend/routes.ts";

export const access: ServerModule = {
  name: "access",
  httpBefore: registerAccessGuard,
  http: registerAccess,
  indexing: { submit: "deny" },
  backup: { remote: "deny" },
  retention: async () => {
    const removed = await sql`DELETE FROM access_sessions WHERE expires_at <= now()`;
    return { expiredMemberSessions: removed.count };
  },
};
