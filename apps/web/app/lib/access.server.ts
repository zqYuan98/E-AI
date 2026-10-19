import { data, redirectDocument } from "react-router";
import { loginLocation, pageTarget, safeReturnPath, type AccessPrincipal } from "@aihot/contracts/access";
import type { AdminMe } from "@aihot/contracts/admin";
import { ACCESS, PRIVATE_HEADERS } from "./access.ts";
import { API_BASE_URL } from "./api.server.ts";

/** Every call belongs to this request. No cookie, principal or privileged token is held by the process. */
export async function sessionResponse(request: Request, admin = false): Promise<Response> {
  try {
    return await fetch(`${API_BASE_URL}${admin ? "/api/admin/me" : ACCESS!.sessionPath}`, {
      headers: { accept: "application/json", cookie: request.headers.get("cookie") ?? "", "user-agent": request.headers.get("user-agent") ?? "" },
      redirect: "manual", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]),
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}

export function signInLocation(request: Request, admin = false): string {
  const url = new URL(request.url);
  const back = pageTarget(url.pathname + url.search)?.href ?? "/";
  return admin ? `/api/auth/login?${new URLSearchParams({ return: safeReturnPath(back, { loginPath: "/admin/login" }) })}` : loginLocation(ACCESS!, back);
}

export async function requireAccess(request: Request): Promise<AccessPrincipal | null> {
  if (!ACCESS) return null;
  const res = await sessionResponse(request);
  if (res.status === 401) throw redirectDocument(signInLocation(request), { headers: PRIVATE_HEADERS });
  if (res.status === 403) throw data({ message: "forbidden" }, { status: 403, headers: PRIVATE_HEADERS });
  if (!res.ok) throw data({ message: "unavailable" }, { status: 503, headers: PRIVATE_HEADERS });
  try {
    const who = await res.json() as AccessPrincipal;
    if (!validPrincipal(who)) throw new Error("invalid session");
    return who;
  } catch {
    throw data({ message: "unavailable" }, { status: 503, headers: PRIVATE_HEADERS });
  }
}

export function validPrincipal(value: unknown): value is AccessPrincipal {
  if (!value || typeof value !== "object") return false;
  const v = value as AccessPrincipal;
  return (v.kind === "member" || v.kind === "admin") && new RegExp(`^${v.kind}:[1-9][0-9]*$`).test(v.id)
    && typeof v.name === "string" && typeof v.csrf === "string" && !!v.csrf;
}
export function validAdmin(value: unknown): value is AdminMe {
  const v = value as AdminMe | null;
  return !!v && v.dev === false && typeof v.name === "string" && typeof v.csrf === "string" && !!v.csrf;
}
