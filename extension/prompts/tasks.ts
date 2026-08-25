/**
 * 代理任务："要代理干什么"的纯数据描述。
 * 提示词生成（build.ts）与两条执行通道（commands 主会话 / subagents worker 子进程）
 * 都从任务出发——手动命令与自动挡共用同一组任务语义，不再各自维护一套。
 */
import { GATE_LABEL, type GateState, type PendingEntity } from "../core/gate.ts";
import { messageText } from "../tools/text.ts";

/** 代理任务：按序阅读的格式文件 + 操作手册 + 任务指令 + 附带素材 */
export interface AgentTask {
	/** 格式文件（相对 protocolDir）：entities.md / verifications.md（query 不读，为空） */
	formats: string[];
	/** 操作手册（相对 protocolDir）：record.md / verify.md（query 不读，为空） */
	manuals: string[];
	/** 任务指令：只描述做什么，不掺路径与素材 */
	instructions: string;
	/** 附带素材（record: 对话摘录；verify: 待验清单；query: 检索词） */
	material?: string;
}

/** 记录任务：提炼实体，只读实体面 */
export function recordTask(transcript?: string): AgentTask {
	return {
		formats: ["entities.md"],
		manuals: ["record.md"],
		instructions:
			"按手册提炼长期结论：先检索 .memory/entities 中已有实体（判新增或更新），再新建实体或更新已有实体。不记录临时性细节。",
		material: transcript ? `近期对话素材：\n${transcript}` : undefined,
	};
}

/** 验证任务：核对清单实体（手动命令与自动挡都注入算好的清单，同一筛选） */
export function verifyTask(pending: PendingEntity[]): AgentTask {
	return {
		formats: ["entities.md", "verifications.md"],
		manuals: ["verify.md"],
		instructions:
			"按手册逐一验证下方清单中的每个实体。追加验证记录（证据写在记录正文，只追加不覆盖）。" +
			"只有实际核对过才追加 passed，否则追加 failed 并写明原因。",
		material: `待验证实体：\n${pending.map((e) => `- ${e.id} [${e.kind}] ${GATE_LABEL[e.state]}`).join("\n")}`,
	};
}

/** 检索任务的库索引项：门控态由扩展算好注入，代理不重算 */
export interface QueryIndexEntry {
	id: string;
	kind: string;
	state: GateState;
	path: string;
}

/** 检索任务：注入全库索引（门控预计算）；grep 与判相关交给代理自带工具 */
export function queryTask(terms: string, index: QueryIndexEntry[]): AgentTask {
	const entries = index.map((e) => `- ${e.id} [${e.kind}] ${GATE_LABEL[e.state]} — ${e.path}`).join("\n");
	return {
		formats: [],
		manuals: [],
		instructions:
			"用你自己的工具（grep / rg / read，不区分大小写）在 .memory/entities 中检索下方检索词。" +
			"每个相关命中报告：实体 id、kind、门控状态（查下方索引——已预计算，不要重算）与相关断言；引用实体 id。" +
			"若无相关命中，明确说明没有记录。",
		material: `检索词：${terms || "未给出——从最近对话推断检索意图。"}\n记忆库索引（门控状态由扩展预计算）：\n${entries}`,
	};
}

/** 会话条目最小结构：只取 type 与可选 message（与 pi 的 SessionEntry 结构兼容） */
export interface TranscriptEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** 喂给记录任务的最近会话条目上限 */
const TRANSCRIPT_ENTRY_LIMIT = 30;
/** 每条消息文本截断长度 */
const MESSAGE_TEXT_MAX = 2_000;

/** 从会话抽取最近的对话素材（text 块拼合、逐条截断）——记录任务专用 */
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
