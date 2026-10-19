// Admin loaders read /api/admin/* with the visitor's own cookie; the web process holds no session.
import { data, redirectDocument } from "react-router";
import { pageTarget, safeReturnPath } from "@aihot/contracts/access";
import { ACCESS, PRIVATE_HEADERS } from "./access.ts";
import { API_BASE_URL } from "./api.server.ts";

export async function adminGet<T>(request: Request, path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { accept: "application/json", cookie: request.headers.get("cookie") ?? "", "user-agent": request.headers.get("user-agent") ?? "" },
    cache: "no-store", redirect: "manual",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
  }).catch(() => { throw data({ message: "unavailable" }, { status: 503, headers: PRIVATE_HEADERS }); });
  if (res.status === 401) {
    const url = new URL(request.url);
    throw redirectDocument(`/api/auth/login?${new URLSearchParams({ return: safeReturnPath(pageTarget(url.pathname + url.search)?.href, { loginPath: "/admin/login" }) })}`, { headers: PRIVATE_HEADERS });
  }
  if (res.status === 404) throw data({ message: "not_found" }, { status: 404, headers: PRIVATE_HEADERS });
  if (!res.ok) {
    let detail = `api ${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      // not JSON
    }
    throw data({ message: detail }, { status: res.status >= 500 ? 503 : res.status, headers: PRIVATE_HEADERS });
  }
  const body = await res.json();
  if (ACCESS && path === "/api/admin/me" && body.dev !== false) throw data({ message: "forbidden" }, { status: 403, headers: PRIVATE_HEADERS });
  return body as T;
}
