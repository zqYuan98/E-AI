// 政策规划库在网页上的入口：侧栏“资料”一节，“我的”页一行。
import { defineWebModule } from "@aihot/web/modules";
import { IconLandmark } from "@aihot/web/components/icons";

export const policyWeb = defineWebModule({
  name: "policy",
  sidebar: { section: "资料", items: [{ to: "/policy", label: "政策规划库", icon: IconLandmark }] },
  tools: [{ to: "/policy", label: "政策规划库", icon: <IconLandmark size={20} /> }],
  admin: { groups: [{ group: "资料", items: [{ to: "/admin/policy", label: "政策规划库管理" }] }] },
});
