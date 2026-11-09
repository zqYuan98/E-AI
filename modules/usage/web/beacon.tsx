// 成员每打开一个页面报一次到。页面停留不到半秒的不算（鼠标掠过的预取、重定向、连点）；换查询参数不算新的一页；管理员不报。
import { useEffect } from "react";
import { useLocation, useRouteLoaderData } from "react-router";
import type { AccessPrincipal } from "@aihot/contracts/access";

export function VisitBeacon() {
  const { principal } = (useRouteLoaderData("root") ?? {}) as { principal?: AccessPrincipal };
  const { pathname } = useLocation();
  const csrf = principal?.kind === "member" ? principal.csrf : null;
  useEffect(() => {
    if (!csrf) return;
    const timer = setTimeout(() => {
      // 页面标题在路由切换完成后才更新，所以等这半秒再读。报不上去就算了，不影响读者。
      fetch("/api/site/visit", {
        method: "POST", credentials: "same-origin", keepalive: true,
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ path: pathname, title: document.title }),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [csrf, pathname]);
  return null;
}
