/**
 * lazy-memory 扩展入口：创建 Runtime，注册命令（对齐 pi-observational-memory：
 * runtime 装配 → agents 执行层 → commands 注册；自动模式钩子将来在此挂载）。
 * 零工具注入：模型用通用工具操作 .memory/，PROTOCOL.md 为唯一真相源。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "./commands/index.ts";
import { Runtime } from "./runtime.ts";

/** 扩展工厂 */
export default function lazyMemoryExtension(pi: ExtensionAPI): void {
	const runtime = new Runtime(pi);
	registerMemoryCommands(pi, runtime);
}