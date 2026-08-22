/**
 * 命令注册入口：组装 SettlerActions 并注册全部 5 个命令。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSettlerActions } from "../agents/settler/agent.ts";
import type { Runtime } from "../runtime.ts";
import { registerModeCommand } from "./mode.ts";
import { registerOverviewCommand } from "./overview.ts";
import { registerQueryCommand } from "./query.ts";
import { registerRecordCommand } from "./record.ts";
import { registerVerifyCommand } from "./verify.ts";

/** 注册 5 个 /memory 命令（总览 / 沉淀 / 检索 / 验证 / 挡位） */
export function registerMemoryCommands(pi: ExtensionAPI, runtime: Runtime): void {
	const actions = createSettlerActions(runtime);
	registerOverviewCommand(pi);
	registerModeCommand(pi);
	registerRecordCommand(pi, actions);
	registerQueryCommand(pi, actions);
	registerVerifyCommand(pi, actions);
}