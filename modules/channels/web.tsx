// 频道在网页上的入口：侧栏“频道”一节，手机底栏的“商机”“热点”，“我的”页一行政策动态。
import { defineWebModule } from "@aihot/web/modules";
import { IconChart, IconInfo, IconTrendUp } from "@aihot/web/components/icons";

export const channelsWeb = defineWebModule({
  name: "channels",
  sidebar: {
    section: "频道",
    items: [
      { to: "/tenders", label: "招标商机", icon: IconChart },
      { to: "/policy-news", label: "政策动态", icon: IconInfo },
      { to: "/trends", label: "行业热点", icon: IconTrendUp },
    ],
  },
  tabs: [
    { key: "tenders", to: "/tenders", label: "商机", icon: IconChart },
    { key: "trends", to: "/trends", label: "热点", icon: IconTrendUp },
  ],
  tools: [{ to: "/policy-news", label: "政策动态", icon: <IconInfo size={18} /> }],
});
