// A site opts in through its module declaration; public sites keep their existing behavior.
import { siteAccess } from "@aihot/contracts/access";
import { MODULES } from "@aihot/site/modules";

export const ACCESS = siteAccess(MODULES);
export const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Accel-Expires": "0", "Surrogate-Control": "no-store" };
