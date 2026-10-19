// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import type { ServerModule } from "@aihot/backend/modules";
import { access } from "@aihot/access/server";
import { policy } from "@aihot/policy/server";
import { research } from "@aihot/research/server";
import { wechat } from "@aihot/wechat/server";

export const SERVER_MODULES: readonly ServerModule[] = [access, policy, research, wechat];
