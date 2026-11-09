// 访问统计在网页上的入口：每个页面底部的不可见报到组件，后台“访问控制”一组里的“访问统计”。
import { defineWebModule } from "@aihot/web/modules";
import { VisitBeacon } from "./web/beacon.tsx";

export const usageWeb = defineWebModule({
  name: "usage",
  root: { Bottom: VisitBeacon },
  admin: { groups: [{ group: "访问控制", items: [{ to: "/admin/usage", label: "访问统计" }] }] },
});
