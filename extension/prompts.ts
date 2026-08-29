/**
 * 代理任务与提示词：手动命令（主会话注入）与 auto 挡（worker 子进程）共用同一任务语义。
 * AgentTask 是"要代理干什么"的纯数据；规则细节以 protocol/ 手册为唯一真相源，
 * 提示词只说"按手册执行"，不复述手册内容。
 */
import { join } from "node:path";
import { GATE_LABEL, type GateState, type PendingEntity } from "./gate.ts";
import { memoryDir } from "./store.ts";
import { messageText } from "./utils.ts";
import type { Runtime } from "./index.ts";

// ---- 任务定义 ----

/** 代理任务：按序阅读的格式手册 + 操作手册 + 任务指令 + 附带素材 */
export interface AgentTask {
	/** 格式手册（相对 protocolDir）：entities.md / verifications.md（query 不读，为空） */
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
		instructions: "按手册提炼长期结论：先查已有实体判新增或更新，再写入。不记录临时性细节。",
		material: transcript ? `近期对话素材：\n${transcript}` : undefined,
	};
}

/** 验证任务：核对清单实体；failed 进"待修正"段（修正步骤以 verify.md 为准，此处不复述） */
export function verifyTask(pending: PendingEntity[]): AgentTask {
	const fix = pending.filter((e) => e.state === "failed");
	const check = pending.filter((e) => e.state !== "failed");
	const lines: string[] = [];
	if (fix.length > 0) {
		lines.push("待修正（先按最新 failed 记录修正正文再复验）：");
		lines.push(...fix.map((e) => `- ${e.id} [${e.kind}] ${GATE_LABEL[e.state]}`));
	}
	if (check.length > 0) {
		lines.push("待验证：");
		lines.push(...check.map((e) => `- ${e.id} [${e.kind}] ${GATE_LABEL[e.state]}`));
	}
	return {
		formats: ["entities.md", "verifications.md"],
		manuals: ["verify.md"],
		instructions: "按手册逐一处理下方清单实体。只有实际核对过才追加 passed，否则追加 failed 并写明原因（含无效断言编号）。",
		material: lines.join("\n"),
	};
}

/** 检索任务的库索引项：门控态由扩展算好注入，代理不重算 */
export interface QueryIndexEntry {
	id: string;
	kind: string;
	state: GateState;
	path: string;
}

/** 检索任务：注入全库索引（门控预计算）；grep 与相关性判断交给代理自带工具 */
export function queryTask(terms: string, index: QueryIndexEntry[]): AgentTask {
	const entries = index.map((e) => `- ${e.id} [${e.kind}] ${GATE_LABEL[e.state]} — ${e.path}`).join("\n");
	return {
		formats: [],
		manuals: [],
		instructions:
			"用你自己的工具（grep / rg / read，不区分大小写）在库根的 entities/ 中检索下方检索词。" +
			"每个相关命中报告：实体 id、kind、门控状态（查下方索引，不要重算）与相关断言。" +
			"若无相关命中，明确说明没有记录。",
		material: `检索词：${terms || "未给出——从最近对话推断检索意图。"}\n记忆库索引（门控状态由扩展预计算）：\n${entries}`,
	};
}

// ---- 会话素材抽取 ----

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

// ---- 提示词组装与注入 ----

/** 手册引用行：格式手册 + 操作手册绝对路径，按序阅读 */
function refLine(protocolDir: string, task: AgentTask): string {
	return [...task.formats, ...task.manuals].map((f) => join(protocolDir, f)).join(", ");
}

/**
 * 库根定义行：手册一律用"库根"指代记忆库根目录（不写字面路径），
 * 绝对路径只由两条通道的提示词给出——$MEMORY_DIR 覆盖时不会把手册与真路径劈成两套。
 */
function rootLine(cwd: string | undefined): string {
	return `库根（记忆库根目录）= ${memoryDir(cwd)}。手册里的"库根"即指该目录，文件操作一律用此绝对路径。`;
}

/** 主会话注入消息（/memory 命令用）：已读手册不重复读 */
export function buildAgentPrompt(task: AgentTask, protocolDir: string, cwd: string | undefined): string {
	const refs = refLine(protocolDir, task);
	const head = refs ? `若本会话尚未读过 ${refs}，先读；已读则直接执行。` : "";
	const parts = [`[pi-lazy-evo] 记忆库操作请求。${head}${task.instructions}`, rootLine(cwd)];
	if (task.material) parts.push(task.material);
	return parts.join("\n");
}

/** 主会话注入通道：任务 → 提示词 → dispatch 唤醒主会话代理（手动 /memory 命令用） */
export function injectTask(runtime: Runtime, task: AgentTask): void {
	runtime.dispatch(buildAgentPrompt(task, runtime.protocolDir, runtime.cwd));
}

/** 子进程提示（auto 挡 worker 用）：独立上下文，自含角色/库根/轮数约束 */
export function buildWorkerPrompt(task: AgentTask, protocolDir: string, cwd: string, maxTurns: number): string {
	const parts = [`你是 pi-lazy-evo 记忆库代理。${rootLine(cwd)}`, `- 先读手册：${refLine(protocolDir, task)}。`, `- 任务：${task.instructions}`];
	if (task.material) parts.push(`- 素材：\n${task.material}`);
	parts.push(`- 约束：最多 ${maxTurns} 轮精简回复；不得触碰库根以外的任何内容；结束时用一句话总结。`);
	return parts.join("\n");
}