/**
 * 代理动作："要代理干什么"的纯数据描述。
 * 提示词生成（prompts.ts）与两条执行通道（main.ts 主会话 / workers/worker.ts 子进程）
 * 都从动作出发——手动命令与自动挡共用同一组任务语义，不再各自维护一套。
 */
import type { PendingEntity } from "../core/gate.ts";

/** 代理任务：按序阅读的格式文件 + 操作手册 + 任务指令 + 附带素材 */
export interface AgentTask {
	/** 格式文件（相对 protocolDir）：entities.md / verifications.md */
	formats: string[];
	/** 操作手册（相对 protocolDir）：record.md / query.md / verify.md */
	manuals: string[];
	/** 任务指令：只描述做什么，不掺路径与素材 */
	instructions: string;
	/** 附带素材（record: 对话摘录；verify: 待验清单；query: 检索词） */
	material?: string;
}

/** 沉淀任务：提炼实体，只读实体面 */
export function recordTask(transcript?: string): AgentTask {
	return {
		formats: ["entities.md"],
		manuals: ["record.md"],
		instructions:
			"Settle durable conclusions: search .memory/entities for related entities yourself (grep/read), " +
			"create new entities or update existing ones following the protocol (id/kind/sources/assertions; " +
			"sources appended with ； without duplicating existing ones). " +
			"Do not record transient details; only durable conclusions worth citing later.",
		material: transcript ? `Recent conversation (for settling):\n${transcript}` : undefined,
	};
}

/** 验证任务：核对清单实体（手动命令与自动挡都注入算好的清单，同一筛选） */
export function verifyTask(pending: PendingEntity[]): AgentTask {
	return {
		formats: ["entities.md", "verifications.md"],
		manuals: ["verify.md"],
		instructions:
			"Verify each entity in the list below: check front-matter format, conflicts against other entities, " +
			"run command checks and web research as needed (network tools may or may not be available). " +
			"Append verification records following the protocol (validator + checked_at + result + evidence; " +
			"evidence required, append-only). Only append passed when you actually verified; " +
			"otherwise append failed with the reason. Report the gate states after verification.",
		material: `Entities pending verification:\n${pending.map((e) => `- ${e.id} [${e.kind}] ${e.state}`).join("\n")}`,
	};
}

/** 检索任务：关键词可空 */
export function queryTask(terms: string): AgentTask {
	return {
		formats: ["entities.md", "verifications.md"],
		manuals: ["query.md"],
		instructions:
			"Search .memory/entities yourself (grep/read). For each hit report: entity id, kind, " +
			"gate state (passed / failed / unverified / stale, by comparing the latest verification " +
			"against the file mtime), and relevant assertions. Cite entity ids; if nothing relevant " +
			"is found, state that there is no record.",
		material: terms ? `Search terms: ${terms}` : "No search terms given — infer the search intent from the recent conversation.",
	};
}

/** 会话条目最小结构：只取 type 与可选 message（与 pi 的 SessionEntry 结构兼容） */
export interface TranscriptEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** 喂给沉淀任务的最近会话条目上限 */
const TRANSCRIPT_ENTRY_LIMIT = 30;
/** 每条消息文本截断长度 */
const MESSAGE_TEXT_MAX = 2_000;

/** 从会话抽取最近的对话素材（text 块拼合、逐条截断）——沉淀任务专用 */
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