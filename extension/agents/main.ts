/**
 * 主会话通道：任务 → 提示词 → dispatch 注入主会话（手动 /memory 命令用）。
 * 命令扳机只算输入 → runner.run(task)，零装配。
 */
import type { Runtime } from "../index.ts";
import type { AgentTask } from "./actions.ts";
import { buildAgentPrompt } from "./prompts.ts";

/** 主会话执行器 */
export interface MainRunner {
	/** 注入一条任务提示词唤醒主会话代理 */
	run(task: AgentTask): void;
}

/** 用运行时构建主会话执行器（协议路径与注入通道都来自 runtime） */
export function createMainRunner(runtime: Runtime): MainRunner {
	return { run: (task) => runtime.dispatch(buildAgentPrompt(task, runtime.protocolDir)) };
}