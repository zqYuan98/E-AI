// 频道的地址：招标商机、政策动态、行业热点。三页共用 web/channel.tsx，读的是引擎的“全部动态”接口（/api/site/pool）。
import { defineModule } from "@aihot/contracts/modules";

export const channels = defineModule({
  name: "channels",
  pages: [
    { path: "tenders", file: "web/tenders.tsx" },
    { path: "policy-news", file: "web/policy-news.tsx" },
    { path: "trends", file: "web/trends.tsx" },
  ],
});
