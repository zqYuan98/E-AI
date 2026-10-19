// 公众号接入：定时读取公众号转 RSS 服务（wewe-rss、we-mp-rss 等）输出的 JSON Feed，每个公众号建一个信源，
// 文章连同正文送进和普通采集一样的判重、精选和归组。服务地址只来自部署配置（WECHAT_FEED_URL），
// 它在内网里，所以不走信源抓取的公网地址检查。
import type { ServerModule } from "@aihot/backend/modules";
import { feedUrl, syncWechatFeed } from "./backend/sync.ts";

export const wechat: ServerModule = {
  name: "wechat",
  // Reading the feed is collection: it stays off with COLLECT_ENABLED like every other source.
  schedules: [{ name: "wechat-feed", cron: "11,41 * * * *", run: syncWechatFeed, missed: "skip", when: () => process.env.COLLECT_ENABLED === "true" && !!feedUrl() }],
};
