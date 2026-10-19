// Run switches on the admin settings page, beneath the deployment's valves. COLLECT_ENABLED and MODEL_CALLS_ENABLED
// in the environment decide whether a thing may run at all; within that, the admin pauses and resumes collection
// and model calls without a restart. A paused model call waits (the article is retried later), it never fails.
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { BudgetExceededError } from "../providers/receipts.ts";

export type RunSwitch = "collect" | "models";
export interface RunSwitches { collect: boolean; models: boolean }

const KEY = "ops.switches";
let cache: { at: number; value: RunSwitches } | null = null;

/** What the environment allows; the admin cannot turn on what it does not. */
export const allowedByEnvironment = (name: RunSwitch) => (name === "collect" ? process.env.COLLECT_ENABLED === "true" : config.modelCallsEnabled);

/** The admin's switches (on unless paused), cached for 15 seconds in each process. */
export async function runSwitches(): Promise<RunSwitches> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const [row] = await sql<{ value: Partial<RunSwitches> }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  const value = { collect: row?.value.collect !== false, models: row?.value.models !== false };
  cache = { at: Date.now(), value };
  return value;
}

export const collectionOn = async () => allowedByEnvironment("collect") && (await runSwitches()).collect;
export const modelCallsOn = async () => allowedByEnvironment("models") && (await runSwitches()).models;

/** A model call while the admin has paused them: the caller waits and retries, like a full budget window. */
export class ModelCallsPaused extends BudgetExceededError {
  constructor() {
    super("llm", "paused", 300);
    this.message = "Model calls are paused on the admin settings page";
  }
}

export async function setRunSwitch(name: RunSwitch, on: boolean, reason: string, actor: string) {
  if (name !== "collect" && name !== "models") throw Object.assign(new Error("unknown switch"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (on && !allowedByEnvironment(name)) {
    throw Object.assign(new Error(`服务器的 ${name === "collect" ? "COLLECT_ENABLED" : "MODEL_CALLS_ENABLED"} 不是 true，后台不能打开；先在服务器 .env 里改`), { statusCode: 400 });
  }
  const before = await runSwitches();
  const after = { ...before, [name]: on };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${KEY}, ${sql.json(after)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  cache = null;
  await audit(actor, "ops.switch", `switch:${name}`, reason, { on: before[name] }, { on });
  return { name, on };
}

/** For the settings page: each switch, whether the environment allows it and whether it runs now. */
export async function runSwitchStatus() {
  const s = await runSwitches();
  return (["collect", "models"] as const).map((name) => ({ name, allowed: allowedByEnvironment(name), on: s[name], running: allowedByEnvironment(name) && s[name] }));
}
