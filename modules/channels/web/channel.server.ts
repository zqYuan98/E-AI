// 频道页的 loader（只在服务器上运行）：先读这个频道现在的设置和自动话题，再按地址里的筛选读 /api/site/pool。
import type { PoolResponse } from "@aihot/contracts/site";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { CHANNELS, channelAt, readQuery, type ChannelView } from "../channels.ts";

export async function channelLoader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const key = channelAt(url.pathname);
  if (!key) throw new Response("Not found", { status: 404 });
  const view = await apiGet<ChannelView>(`/api/site/channels/${key}`, { request, signal: request.signal });
  const query = readQuery(key, view, url.searchParams);
  const api = new URLSearchParams(query.category ? { category: query.category } : { categories: CHANNELS[key].categories.join(",") });
  if (query.tag) api.set("tag", query.tag);
  if (query.q) api.set("q", query.q);
  if (query.page > 1) api.set("page", String(query.page));
  const data = await apiGet<PoolResponse>(`/api/site/pool?${api}`, { request, signal: request.signal });
  return cachedPage(60, { key, view, query, data });
}
