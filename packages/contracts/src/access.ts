// Internal access, for a site one of whose modules declares it (ModuleDeclaration.access): who a request is,
// and how the web server and the development server send a visitor without a session to sign in. Types and
// pure functions with no server dependency, so the api, the web server, the build and the pages read the same
// rules. Only the api decides who a request is, from its own session cookies on every request: never from a
// header a caller sets (x-aihot-ssr, X-Forwarded-*), the caller's address or a shared token.

export type AccessKind = "admin" | "member";

/**
 * Who a request is, as the api decided it from a live session: a member's, else a real admin's (never the
 * development stand-in). The id is namespaced, so an admin and a member never share one, and it is also the
 * actor in the audit trail: "admin:<admin_users.id>" or "member:<the member's id>".
 */
export interface AccessPrincipal {
  readonly id: `${AccessKind}:${number}`;
  readonly kind: AccessKind;
  /** What the pages call them. */
  readonly name: string;
  /** Their session's token: every state change sends it as x-csrf-token. */
  readonly csrf: string;
}

/** The member session's cookie. The admin's (aihot_admin) is apart: signing in or out of one leaves the other. */
export const MEMBER_COOKIE = "aihot_member";

/** POST /api/access/login, a JSON body. */
export interface AccessLogin {
  username: string;
  password: string;
  /** Where the visitor was going; safeReturnPath decides where they go. */
  returnTo?: string;
}

/** The answer of a successful sign-in or sign-out: where the page goes next, a path on this site. */
export interface AccessRedirect {
  redirect: string;
}

/** What the access module declares (ModuleDeclaration.access). */
export interface ModuleAccess {
  /** The sign-in page, one of the module's pages: "/login". */
  loginPath: string;
  /** Says who the visitor is: 200 with an AccessPrincipal, 401 without a live session. "/api/access/session". */
  sessionPath: string;
}

/**
 * The site's access, from its modules (site/modules/index.ts); null on a public site, which then stays as it
 * is. At most one module declares it.
 */
export function siteAccess(modules: ReadonlyArray<{ name: string; access?: ModuleAccess }>): ModuleAccess | null {
  const declaring = modules.filter((m) => m.access);
  if (declaring.length > 1) throw new Error(`more than one module declares access: ${declaring.map((m) => m.name).join(", ")}`);
  const access = declaring[0]?.access;
  if (!access) return null;
  if (!/^(?:\/[a-z0-9-]+)+$/.test(access.loginPath) || /^\/(?:api|admin)(?:\/|$)/.test(access.loginPath)) {
    throw new Error(`access.loginPath must be a page path outside /api and /admin: "${access.loginPath}"`);
  }
  if (!/^\/api(?:\/[a-z0-9-]+)+$/.test(access.sessionPath)) throw new Error(`access.sessionPath must be an /api path: "${access.sessionPath}"`);
  return access;
}

/** A page request's address as the router reads it. */
export interface PageTarget {
  /**
   * Its path with dot segments resolved and each segment percent-decoded, as the router matches it (a "/"
   * inside a segment stays "%2F"); a single-fetch data request's is its page's ("/policy.data" → "/policy",
   * "/_.data" → "/").
   */
  path: string;
  /**
   * The page's own address, path and query still percent-encoded, without a data request's ".data" and the
   * router's `_routes`: what loginLocation returns the visitor to.
   */
  href: string;
  /** A single-fetch data request (".data"). */
  data: boolean;
}

/**
 * Reads a request target (req.url) the way the router will: behind the request's Host header as it came
 * (undefined when there is none), so a Host that carries path characters moves this path as it moves the
 * router's. Null when the target is not an origin-form path or does not parse: answer 400.
 */
export function pageTarget(target: string, host?: string): PageTarget | null {
  if (!target.startsWith("/")) return null;
  let url: URL;
  try {
    // As the router builds its request (`${protocol}//${host}${url}`): an origin-form "//x" stays a path.
    url = new URL(`http://${host ?? "localhost"}${target}`);
  } catch {
    return null;
  }
  let raw = url.pathname;
  const data = raw.endsWith(".data");
  if (data) raw = raw.slice(0, raw.endsWith("/_.data") ? -"_.data".length : -".data".length);
  let path: string;
  try {
    path = raw.split("/").map((segment) => decodeURIComponent(segment).replaceAll("/", "%2F")).join("/");
  } catch {
    return null;
  }
  let search = url.search;
  const query = new URLSearchParams(search);
  if (query.has("_routes")) {
    query.delete("_routes");
    const rest = query.toString();
    search = rest ? `?${rest}` : "";
  }
  return { path, href: `${raw}${search}`, data };
}

/**
 * What a page needs before it is rendered: "open" for the sign-in page; "admin" for the admin's pages, which
 * its own sign-in guards (routes/admin/layout.tsx); "session" for every other page and any path not known.
 */
export type PageGuard = "open" | "admin" | "session";

/** `path` is a PageTarget's. */
export function pageGuard(access: ModuleAccess, path: string): PageGuard {
  if (isLoginPath(access, path)) return "open";
  return /^\/admin(?:\/|$)/i.test(path) ? "admin" : "session";
}

/** Like the router: without case, and with or without a trailing slash. */
function isLoginPath(access: Pick<ModuleAccess, "loginPath">, path: string): boolean {
  const login = access.loginPath.toLowerCase();
  const p = path.toLowerCase();
  return p === login || p === `${login}/`;
}

/** Where to send a visitor without a session: the sign-in page, with where they were going as ?returnTo= unless that is "/". */
export function loginLocation(access: ModuleAccess, returnTo: string): string {
  const back = safeReturnPath(returnTo, access);
  return back === "/" ? access.loginPath : `${access.loginPath}?${new URLSearchParams({ returnTo: back })}`;
}

/**
 * Where a visitor goes after signing in: a path and query on this site, else "/". A whole http(s) URL (a
 * proxy's login redirect may pass one) keeps only its path and query; anything that could leave the site
 * ("//host", "/\host", control characters, another scheme), an /api path, a data request or the sign-in page
 * itself gives "/". The api checks it again: a returnTo is whatever the visitor sent.
 */
export function safeReturnPath(target: unknown, access: Pick<ModuleAccess, "loginPath">): string {
  if (typeof target !== "string" || target.length > 2048) return "/";
  let back = target;
  if (/^https?:\/\//i.test(back)) {
    try {
      const url = new URL(back);
      back = `${url.pathname}${url.search}`;
    } catch {
      return "/";
    }
  }
  // Refused before parsing, which would read "/\host" or "/<tab>/host" as another host.
  if (!back.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(back)) return "/";
  let url: URL;
  try {
    url = new URL(back, "http://return.invalid");
  } catch {
    return "/";
  }
  back = `${url.pathname}${url.search}`;
  if (url.origin !== "http://return.invalid" || back.startsWith("//")) return "/";
  const page = pageTarget(back);
  return !page || page.data || /^\/api(?:\/|$)/i.test(page.path) || isLoginPath(access, page.path) ? "/" : back;
}

/**
 * Whether a state change comes from the site's own pages: its Origin header is one of `origins` (the site's
 * SITE_URL, and any further https origin it answers on). Browsers send Origin with every POST; a missing or
 * opaque ("null") one fails, and so does any other site.
 */
export function originAllowed(origin: string | undefined, origins: readonly string[]): boolean {
  if (!origin) return false;
  try {
    const given = new URL(origin).origin;
    return given !== "null" && origins.some((allowed) => new URL(allowed).origin === given);
  } catch {
    return false;
  }
}
