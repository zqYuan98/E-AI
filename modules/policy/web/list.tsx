// 政策规划库列表：按发文层级、类型、AI 相关程度筛选；上方是国家和两网的关键目标对照表。
import { useLoaderData, useSearchParams } from "react-router";
import { SITE } from "@aihot/site";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { POLICY_LEVELS, POLICY_TYPES, type PolicyDocCard, type PolicyListResponse } from "../types.ts";
import { AI_TONE, aiLabel, levelLabel } from "./labels.ts";

export const handle: Screen = { home: "me", name: "政策规划" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

const KEYS = ["level", "type", "ai", "q"] as const;

export async function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const k of KEYS) if (params.get(k)) query.set(k, params.get(k)!);
  return cachedPage(300, await apiGet<PolicyListResponse>(`/api/site/policy${query.size ? `?${query}` : ""}`, { request, signal: request.signal }));
}

export function meta() {
  return pageMeta({ title: "政策规划库", description: `${SITE.name} 整理的国家部委、国家电网、南方电网与发电集团的规划、方案和政策文件：文号、目标指标、重点任务与人工智能条款，均可回查原文。`, path: "/policy" });
}

function Chips({ name, options }: { name: (typeof KEYS)[number]; options: Array<[string | null, string]> }) {
  const [params] = useSearchParams();
  const current = params.get(name);
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([value, label]) => {
        const next = new URLSearchParams(params);
        if (value) next.set(name, value);
        else next.delete(name);
        const active = current === value;
        return (
          <IntentLink
            key={label}
            to={`/policy${next.size ? `?${next}` : ""}`}
            preventScrollReset
            className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-3 hover:text-accent"}`}
          >
            {label}
          </IntentLink>
        );
      })}
    </div>
  );
}

function DocCard({ d }: { d: PolicyDocCard }) {
  return (
    <IntentLink to={`/policy/${d.id}`} className="card card-hover block px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="rounded-mark bg-bg-sunk px-1.5 py-0.5 text-ink-3">{levelLabel(d.level)}</span>
        <span className="rounded-mark bg-bg-sunk px-1.5 py-0.5 text-ink-3">{d.docType}</span>
        <span className={`rounded-mark px-1.5 py-0.5 ${AI_TONE[d.aiRelevance]}`}>{aiLabel(d.aiRelevance)}</span>
        {d.date && <time className="num text-ink-4" dateTime={d.date}>{d.date}</time>}
      </div>
      <h3 className="mt-2 text-[15.5px] font-semibold leading-[1.5] text-ink">{d.name}</h3>
      <p className="mt-1 text-[12px] text-ink-4">{[d.issuers.join("、"), d.docNo].filter(Boolean).join(" · ")}</p>
      {d.summary && <p className="mt-2 line-clamp-3 text-[13.5px] leading-[1.75] text-ink-2">{d.summary}</p>}
      {(d.targetCount > 0 || d.aiClauseCount > 0) && (
        <p className="mt-2 text-[12px] text-ink-4">
          {d.targetCount > 0 && (
            <span className="mr-3">
              目标指标 <span className="num font-semibold text-ink-3">{d.targetCount}</span>
            </span>
          )}
          {d.aiClauseCount > 0 && (
            <span>
              AI 条款 <span className="num font-semibold text-ink-3">{d.aiClauseCount}</span>
            </span>
          )}
        </p>
      )}
    </IntentLink>
  );
}

export default function PolicyList() {
  const { docs, targets } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const filtered = KEYS.some((k) => params.get(k));
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="政策规划库" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">政策规划库</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          国家部委、两网与发电集团的规划和政策文件。文号、日期、目标指标、重点任务与 AI 条款都核对过原文，点开可看原话。
        </p>
      </header>

      <div className="mt-4 space-y-2.5">
        {/* A plain GET form: the other filters ride along as hidden fields. */}
        <form method="get" action="/policy" className="flex gap-2">
          {KEYS.filter((k) => k !== "q" && params.get(k)).map((k) => <input key={k} type="hidden" name={k} value={params.get(k)!} />)}
          <input
            type="search" name="q" defaultValue={params.get("q") ?? ""} maxLength={40} placeholder="搜文件名、文号或摘要，例如 人工智能、新型电力系统"
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13.5px] text-ink outline-none focus:border-accent"
          />
          <button type="submit" className="h-9 shrink-0 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-accent">搜索</button>
        </form>
        <Chips name="level" options={[[null, "全部单位"], ...Object.entries(POLICY_LEVELS)]} />
        <Chips name="ai" options={[[null, "全部"], ["any", "涉及 AI"], ["core", "AI 专项"]]} />
        <Chips name="type" options={[[null, "全部类型"], ...POLICY_TYPES.map((t): [string, string] => [t, t])]} />
      </div>

      {!filtered && targets.length > 0 && (
        <section className="mt-8" aria-labelledby="policy-targets">
          <h2 id="policy-targets" className="text-[15px] font-bold text-ink">关键目标对照</h2>
          <p className="mt-0.5 text-[12px] text-ink-4">国家部委与两网文件里写明年份的量化目标，按年份排列；指针停在一行上可看原话。</p>
          <div className="mt-3 overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line-soft text-[12px] text-ink-4">
                <tr>
                  <th className="px-4 py-2 font-medium">年份</th>
                  <th className="px-4 py-2 font-medium">单位</th>
                  <th className="px-4 py-2 font-medium">指标</th>
                  <th className="px-4 py-2 font-medium">目标</th>
                  <th className="px-4 py-2 font-medium">出处</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {targets.map((t, i) => (
                  <tr key={i} title={t.quote}>
                    <td className="num px-4 py-2 text-ink-3">{t.year ?? "—"}</td>
                    <td className="px-4 py-2 text-ink-3">{levelLabel(t.level)}</td>
                    <td className="px-4 py-2 text-ink">{t.metric}</td>
                    <td className="px-4 py-2 font-semibold text-ink">{t.value}</td>
                    <td className="px-4 py-2">
                      <IntentLink to={`/policy/${t.docId}`} className="line-clamp-1 text-accent hover:underline">{t.docName}</IntentLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-8" aria-labelledby="policy-docs">
        <h2 id="policy-docs" className="text-[15px] font-bold text-ink">
          文件 <span className="num text-ink-4">{docs.length}</span>
        </h2>
        {docs.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="还没有符合条件的文件">换一个筛选条件试试；新文件随信源采集陆续入库。</EmptyState>
          </div>
        ) : (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {docs.map((d) => (
              <li key={d.id}>
                <DocCard d={d} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
