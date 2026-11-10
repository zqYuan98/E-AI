// 投标商机在网页上的入口：侧栏“频道”一节、手机底栏的“商机”，后台“商机”一组。
import { defineWebModule } from "@aihot/web/modules";
import { IconChart } from "@aihot/web/components/icons";

export const opportunitiesWeb = defineWebModule({
  name: "opportunities",
  sidebar: { section: "频道", items: [{ to: "/opportunities", label: "投标商机", icon: IconChart }] },
  tabs: [{ key: "opportunities", to: "/opportunities", label: "商机", icon: IconChart }],
  admin: { groups: [{ group: "商机", items: [{ to: "/admin/opportunities", label: "投标商机" }] }] },
});
