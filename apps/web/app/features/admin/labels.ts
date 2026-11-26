// Shared admin vocabulary.
export const KIND_LABEL: Record<string, string> = { rss: "RSS", web_list: "网页列表", json_list: "JSON", x_search: "X", mp_account: "公众号", external: "外部上报" };
export const MODE_LABEL: Record<string, string> = { editorial: "精选", hot_signal: "氛围", isolated: "隔离" };
export const HEALTH_LABEL: Record<string, string> = { ok: "正常", degraded: "不稳定", failing: "失败", paused: "已暂停", unknown: "未检查" };
export const VISIBILITY_LABEL: Record<string, string> = { public: "公开", "summary-only": "仅摘要", withdrawn: "已下架" };
export const FEEDBACK_STATUS: Record<string, string> = { new: "新反馈", triaged: "处理中", replied: "已回复", resolved: "已解决", spam: "垃圾信息" };
export const TIER_LABEL: Record<string, string> = { T1: "T1", T1_5: "T1.5", T2: "T2", EXCLUDE_MP: "排除公众号" };
/** A source's editable settings, as the source page names them. */
export const SOURCE_FIELD_LABEL: Record<string, string> = {
  name: "名称", interval_minutes: "采集间隔", tier: "等级", participation_mode: "参与方式", signal_group_id: "讨论分组", first_party: "一手",
  owner_entity_id: "运营主体", site_fulltext: "站内全文", syndicate_fulltext: "对外接口全文", tags: "标签", config: "采集配置",
};
/** Scheduled jobs, collection runs and external reports. */
export const RUN_STATUS_LABEL: Record<string, string> = { running: "运行中", ok: "成功", failed: "失败", error: "失败", skipped: "跳过" };
export const RECEIPT_STATUS_LABEL: Record<string, string> = { pending: "等待结果", received: "已收到", completed: "已完成", failed: "失败", unknown: "结果未知" };
export const DELIVERY_STATUS_LABEL: Record<string, string> = { pending: "待发送", sending: "发送中", sent: "已送达", failed: "失败", unknown: "结果未知", skipped: "已跳过" };
/** Paid services (receipts and request budgets). */
export const SERVICE_LABEL: Record<string, string> = {
  llm: "默认模型与自加服务商", embedding: "向量服务", jina: "正文兜底（Jina）", socialdata: "X 搜索", dajiala: "公众号列表与正文",
  zhipu: "智谱模型", deepseek: "DeepSeek 模型", dashscope: "阿里云百炼（模型与向量）", mimo: "小米 MiMo 模型",
};
/** Families of audited actions (what comes before the first dot), for the audit page's filter. */
export const AUDIT_ACTION_GROUPS: Record<string, string> = {
  "content.": "内容", "story.": "事件", "source.": "信源", "models.": "模型", "selectbench.": "精选评测", "settings.": "设置", "ops.": "运行开关",
  "budget.": "付费请求上限", "receipt.": "付费回执", "notify.": "通知目的地", "delivery.": "推送投递", "processing.": "重新处理失败",
  "feedback.": "反馈", "access.": "成员", "auth.": "管理员登录", "policy.": "政策规划库", "research.": "研报库", "article.": "原文归属",
};
