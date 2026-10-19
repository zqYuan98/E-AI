// One backup now, the same as the worker's daily ops.backup: with the site's modules installed, so a module
// that denies remote backups (the access module of an internal site) keeps it local here too.
// In Docker:  docker compose exec -T worker node scripts/backup.ts
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { runBackup } from "@aihot/backend/operations/backup";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);
try {
  console.log(JSON.stringify(await runBackup()));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
