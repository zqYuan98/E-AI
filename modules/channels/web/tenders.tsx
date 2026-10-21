// /tenders 的路由：页面在 channel.tsx，这里只声明它在手机底栏的位置。
import type { Screen } from "@aihot/web/components/shell/screens";

export const handle: Screen = { tab: "tenders", name: "商机" };
export { default, headers, loader, meta } from "./channel.tsx";
