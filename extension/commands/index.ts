/**
 * 命令注册入口：组装主会话执行器并注册全部 5 个命令。
 * 注册顺序对齐协议手册：总览 → 沉淀 → 检索 → 验证 → 挡位。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MainRunner } from "../agents/main.ts";
import { registerOverviewCommand } from "./overview.ts";
import { registerRecordCommand } from "./record.ts";
import { registerQueryCommand } from "./query.ts";
import { registerVerifyCommand } from "./verify.ts";
import { registerModeCommand } from "./mode.ts";

/** 注册 5 个 /memory 命令（总览 / 沉淀 / 检索 / 验证 / 挡位） */
export function registerMemoryCommands(pi: ExtensionAPI, runner: MainRunner): void {
	registerOverviewCommand(pi);
	registerRecordCommand(pi, runner);
	registerQueryCommand(pi, runner);
	registerVerifyCommand(pi, runner);
	registerModeCommand(pi);
}