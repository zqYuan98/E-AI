// /tenders 的路由：页面在 channel.tsx，这里声明它在手机底栏的位置。
import type { Screen } from "@aihot/web/components/shell/screens";
import { channelLoader } from "./channel.server.ts";

// 手机底栏的“商机”是项目商机；招标商机频道归在它下面。
export const handle: Screen = { tab: "opportunities", name: "招标商机" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";
export const loader = (args: { request: Request }) => channelLoader(args);
export { default, meta } from "./channel.tsx";
