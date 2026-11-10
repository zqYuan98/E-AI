// 旧地址 /tenders（原“招标商机”频道，已并进投标商机）：永久跳到 /opportunities，带上搜索词。
import { redirect } from "react-router";

export function loader({ request }: { request: Request }) {
  const q = new URL(request.url).searchParams.get("q")?.trim().slice(0, 200);
  throw redirect(q ? `/opportunities?${new URLSearchParams({ q })}` : "/opportunities", 308);
}

export default function TendersMoved() {
  return null;
}
