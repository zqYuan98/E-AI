// 招采申报在网页上的入口：侧栏“内容”一节、“我的”页一行；条目页标题下的“标讯要素”。
import { defineWebModule } from "@aihot/web/modules";
import { IconBriefcase } from "@aihot/web/components/icons";

export const tenderWeb = defineWebModule({
  name: "tender",
  sidebar: { section: "内容", items: [{ to: "/procurement", label: "招采申报", icon: IconBriefcase }] },
  tools: [{ to: "/procurement", label: "招采申报", icon: <IconBriefcase size={20} /> }],
  itemPage: () => import("./web/item-part.tsx"),
});
