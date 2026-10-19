// 研报库在网页上的入口：侧栏“资料”一节、“我的”页一行，后台“资料”一组。
import { defineWebModule } from "@aihot/web/modules";
import { IconGrid } from "@aihot/web/components/icons";

export const researchWeb = defineWebModule({
  name: "research",
  sidebar: { section: "资料", items: [{ to: "/research", label: "研报库", icon: IconGrid }] },
  tools: [{ to: "/research", label: "研报库", icon: <IconGrid size={18} /> }],
  admin: { groups: [{ group: "资料", items: [{ to: "/admin/research", label: "研报库管理" }] }] },
});
