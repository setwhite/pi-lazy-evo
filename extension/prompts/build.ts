/**
 * 提示词组装与注入：任务（纯数据）→ 提示词文本 → 发送。
 * 两条通道共用任务语义（手册引用 + 指令 + 素材）：
 * - buildAgentPrompt + injectTask：主会话注入（手动命令，模型有完整上下文，精简）；
 * - buildWorkerPrompt：子进程系统提示（auto 挡，独立上下文，自含角色/记忆库根/轮数约束）。
 */
import type { Runtime } from "../index.ts";
import type { AgentTask } from "./tasks.ts";
import { join } from "node:path";
import { memoryDir } from "../core/layout.ts";

/** 引用行：格式文件 + 操作手册的绝对路径（join 拼接，保持平台分隔符一致），按序阅读 */
function refLine(protocolDir: string, task: AgentTask): string {
	return [...task.formats, ...task.manuals].map((f) => join(protocolDir, f)).join(", ");
}

/** 主会话注入消息（/memory 命令用）；无手册引用的任务（query）省略读协议前缀 */
export function buildAgentPrompt(task: AgentTask, protocolDir: string): string {
	const refs = refLine(protocolDir, task);
	const head = refs ? `若本会话尚未读过 ${refs}，先读；已读过则直接按协议执行，不要重复读取。然后：` : "";
	const parts = [`[lazy-memory] 收到记忆库操作请求。${head}${task.instructions}`];
	if (task.material) parts.push(task.material);
	return parts.join("\n");
}

/** 主会话注入通道：任务 → 提示词 → dispatch 唤醒主会话代理（手动 /memory 命令用） */
export function injectTask(runtime: Runtime, task: AgentTask): void {
	runtime.dispatch(buildAgentPrompt(task, runtime.protocolDir));
}

/** 子进程系统提示（auto 挡 worker 用） */
export function buildWorkerPrompt(task: AgentTask, protocolDir: string, cwd: string, maxTurns: number): string {
	const parts = [
		`你是 lazy-memory 后台代理。操作位于 ${memoryDir(cwd)} 的记忆库（使用绝对路径）。`,
		`- 协议：操作前先读 ${refLine(protocolDir, task)}。`,
		`- 任务：${task.instructions}`,
	];
	if (task.material) parts.push(`- 素材：\n${task.material}`);
	parts.push(`- 约束：最多 ${maxTurns} 轮精简回复；不得触碰 .memory/ 以外的任何内容；结束时用一句话总结。`);
	return parts.join("\n");
}
