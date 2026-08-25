/**
 * 提示词生成：任务（纯数据）→ 提示词文本。
 * 两条通道共用任务语义（手册引用 + 指令 + 素材）：
 * - buildAgentPrompt：主会话注入消息（模型有完整上下文，精简）；
 * - buildWorkerPrompt：子进程系统提示（独立上下文，自含角色/记忆库根/轮数约束）。
 * 手动/自动不再各写一套提示词。
 */
import type { AgentTask } from "./actions.ts";

/** 引用行：格式文件 + 操作手册的绝对路径，按序阅读 */
function refLine(protocolDir: string, task: AgentTask): string {
	return [...task.formats, ...task.manuals].map((f) => `${protocolDir}/${f}`).join(", ");
}

/** 主会话注入消息（/memory 命令用） */
export function buildAgentPrompt(task: AgentTask, protocolDir: string): string {
	const parts = [`[lazy-memory] A memory action is requested. Read ${refLine(protocolDir, task)} first, then: ${task.instructions}`];
	if (task.material) parts.push(task.material);
	return parts.join("\n");
}

/** 子进程系统提示（auto 挡 worker 用） */
export function buildWorkerPrompt(task: AgentTask, protocolDir: string, cwd: string, maxTurns: number): string {
	const parts = [
		`You are the lazy-memory background agent. Operate the memory library at ${cwd}/.memory (use absolute paths).`,
		`- Protocol: read ${refLine(protocolDir, task)} before operating.`,
		`- Task: ${task.instructions}`,
	];
	if (task.material) parts.push(`- Material:\n${task.material}`);
	parts.push(`- Constraints: at most ${maxTurns} concise turns; touch nothing outside .memory/; finish with a one-sentence summary.`);
	return parts.join("\n");
}