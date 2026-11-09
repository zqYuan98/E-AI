// 钉钉工作台免登：同事在钉钉里打开本站，登录页向钉钉要一个免登码，这里用企业内部应用的凭据换出这个人的钉钉身份。
// 免登码只发给本企业的人，所以能换出身份的就是本企业成员；离开企业以后拿不到免登码，也就进不来。
import { credential } from "@aihot/backend/config";

const API = "https://oapi.dingtalk.com";

/** 钉钉拒绝了请求：免登码过期或用过、应用凭据不对、服务器出口 IP 不在应用的白名单里等，errmsg 里有原因。 */
export class DingtalkRefused extends Error {
  readonly errcode: number;
  constructor(errcode: number, errmsg: string) {
    super(`dingtalk ${errcode}: ${errmsg}`);
    this.errcode = errcode;
  }
}

/** 登录页要的两项；三项凭据缺一项就是没开钉钉登录。 */
export function dingtalkLogin(): { corpId: string; clientId: string } | null {
  const corpId = credential("integrations", "DINGTALK_CORP_ID");
  const clientId = credential("integrations", "DINGTALK_APP_KEY");
  return corpId && clientId && credential("integrations", "DINGTALK_APP_SECRET") ? { corpId, clientId } : null;
}

async function call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`dingtalk HTTP ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  if (body.errcode !== 0) throw new DingtalkRefused(Number(body.errcode), String(body.errmsg ?? "").slice(0, 200));
  return body;
}

// 应用的访问令牌两小时有效，期间重复取拿到的是同一个；提前五分钟换新。
let token: { value: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.until > Date.now()) return token.value;
  const appkey = credential("integrations", "DINGTALK_APP_KEY")!;
  const appsecret = credential("integrations", "DINGTALK_APP_SECRET")!;
  const body = await call(`${API}/gettoken?${new URLSearchParams({ appkey, appsecret })}`);
  const seconds = Number(body.expires_in) || 7200;
  token = { value: String(body.access_token), until: Date.now() + Math.max(60, seconds - 300) * 1000 };
  return token.value;
}

/** 免登码背后的人。钉钉拒绝时抛 DingtalkRefused，并丢掉缓存的令牌：凭据换过以后，下一次重新取。 */
export async function dingtalkUser(code: string): Promise<{ userId: string; name: string }> {
  try {
    const body = await call(`${API}/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(await accessToken())}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    const result = (body.result ?? {}) as { userid?: unknown; name?: unknown };
    if (typeof result.userid !== "string" || !result.userid) throw new DingtalkRefused(-1, "no userid in the answer");
    return { userId: result.userid, name: typeof result.name === "string" ? result.name : "" };
  } catch (error) {
    if (error instanceof DingtalkRefused) token = null;
    throw error;
  }
}
