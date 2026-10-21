// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import { accessWeb } from "@aihot/access/web";
import { channelsWeb } from "@aihot/channels/web";
import { policyWeb } from "@aihot/policy/web";
import { researchWeb } from "@aihot/research/web";

export const WEB_MODULES: readonly WebModule[] = [accessWeb, channelsWeb, policyWeb, researchWeb];
