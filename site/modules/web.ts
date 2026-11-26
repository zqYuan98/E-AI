// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import { accessWeb } from "@aihot/access/web";
import { policyWeb } from "@aihot/policy/web";
import { researchWeb } from "@aihot/research/web";
import { tenderWeb } from "@aihot/tender/web";

export const WEB_MODULES: readonly WebModule[] = [accessWeb, tenderWeb, policyWeb, researchWeb];
