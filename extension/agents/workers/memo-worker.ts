/**
 * 沉淀 worker：喂最近会话素材，按 entities.md + record.md 提炼实体。
 * 只读实体面（entities.md）——从不触碰验证面（verifications.md）。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../../core/config.ts";
import type { Runtime } from "../../index.ts";
import { promptHeader, runSingleWorker } from "./worker.ts";

/** 喂给沉淀 worker 的最近会话条目上限 */
const TRANSCRIPT_ENTRY_LIMIT = 30;
/** 每条消息文本截断长度 */
const MESSAGE_TEXT_MAX = 2_000;

/** 会话条目最小结构：只取 type 与可选 message（与 pi 的 SessionEntry 结构兼容） */
export interface TranscriptEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** 从会话抽取最近的对话素材（text 块拼合、逐条截断）——沉淀 worker 专用 */
export function extractTranscript(entries: readonly TranscriptEntry[], limit = TRANSCRIPT_ENTRY_LIMIT): string {
	const messages = entries
		.filter((e) => e.type === "message" && e.message)
		.slice(-limit)
		.map((e) => {
			const m = e.message!;
			return `${m.role ?? "unknown"}: ${messageText(m.content)}`.slice(0, MESSAGE_TEXT_MAX);
		});
	return messages.join("\n\n");
}

/** 沉淀 worker 提示词：只做提炼（record），带会话素材，只需实体面 */
export function buildMemoWorkerPrompt(input: { protocolDir: string; cwd: string; transcript: string; maxTurns: number }): string {
	return [
		"你是 lazy-memory 的后台记忆沉淀代理，任务是在 headless 环境里操作 .memory/ 记忆库。",
		`- 协议手册：先读 ${input.protocolDir}/entities.md（实体格式），再按 ${input.protocolDir}/record.md 执行。`,
		"- 任务：从下面给的最近对话素材里提炼长期稳定事实；用 grep 对照 .memory/entities/ 已有实体判定新增/更新；sources 追加用 ； 分隔不重复。只写值得日后引用的结论。",
		...promptHeader(input.cwd, input.maxTurns),
		"",
		"=== 最近对话素材（供沉淀提炼）===",
		input.transcript || "（无可用素材）",
	].join("\n");
}

/** 跑沉淀 worker：取素材 → 拼提示词 → 执行 */
export async function runMemoWorker(runtime: Runtime, ctx: ExtensionContext, config: MemorySettings): Promise<void> {
	const transcript = extractTranscript(ctx.sessionManager.getEntries());
	const prompt = buildMemoWorkerPrompt({ protocolDir: runtime.protocolDir, cwd: ctx.cwd, transcript, maxTurns: config.autoMaxTurns });
	await runSingleWorker("沉淀", ctx, config, config.autoMemoTools, prompt);
}

/** 消息 content 提取纯文本（兼容字符串与 block 数组） */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text?: unknown } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
			.map((b) => (typeof b.text === "string" ? b.text : ""))
			.join("");
	}
	return "";
}