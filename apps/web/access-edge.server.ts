// Both edges run this BEFORE redirects, static files, SSR or conditional 304s.
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import { pageGuard, type PageTarget } from "@aihot/contracts/access";
import { ACCESS, PRIVATE_HEADERS } from "./app/lib/access.ts";
import { sessionResponse, signInLocation, validAdmin, validPrincipal } from "./app/lib/access.server.ts";

/** Final writer: neither Vite, pageResponse nor a route may make an internal response shareable. */
export function privateResponse(res: ServerResponse) {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, messageOrHeaders?: string | OutgoingHttpHeaders, headers?: OutgoingHttpHeaders) => {
    const outgoing = typeof messageOrHeaders === "string" ? headers : messageOrHeaders;
    for (const [name, value] of Object.entries(outgoing ?? {})) if (value !== undefined) res.setHeader(name, value);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) res.setHeader(name, value);
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.removeHeader("Expires");
    res.removeHeader("ETag");
    res.removeHeader("Last-Modified");
    return typeof messageOrHeaders === "string" ? writeHead(status, messageOrHeaders) : writeHead(status);
  }) as typeof res.writeHead;
}

/** true means answered here; false means the route may execute. API paths never come here. */
export async function guardPage(req: IncomingMessage, res: ServerResponse, target: PageTarget): Promise<boolean> {
  if (!ACCESS) return false;
  const guard = pageGuard(ACCESS, target.path);
  if (guard === "open" || /^\/admin\/login\/?$/i.test(target.path)) return false;
  const request = new Request(`http://web.local${target.href}`, { headers: { cookie: req.headers.cookie ?? "", "user-agent": req.headers["user-agent"] ?? "" } });
  const response = await sessionResponse(request, guard === "admin");
  if (response.status === 401) {
    const location = signInLocation(request, guard === "admin");
    if (target.data) res.writeHead(204, { "X-Remix-Redirect": location, "X-Remix-Status": "302", "X-Remix-Reload-Document": "true", "X-Remix-Replace": "true" });
    else res.writeHead(302, { Location: location });
    res.end();
    return true;
  }
  let valid = false;
  if (response.ok) {
    const who: unknown = await response.json().catch(() => null);
    valid = guard === "admin" ? validAdmin(who) : validPrincipal(who);
  }
  if (valid) return false;
  res.writeHead(response.status === 403 ? 403 : 503, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(req.method === "HEAD" ? undefined : response.status === 403 ? "没有访问权限。" : "身份服务暂不可用，请稍后重试。");
  return true;
}

export function rejectPage(req: IncomingMessage, res: ServerResponse, status: number) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS });
  res.end(req.method === "HEAD" ? undefined : status === 400 ? "Bad request" : "Service unavailable");
}
