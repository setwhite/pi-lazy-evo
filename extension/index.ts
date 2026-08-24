/**
 * lazy-memory 扩展入口：装配 Runtime，注册命令与 auto 钩子（turn_end 时钟 + token 水位）。
 * Runtime 与入口同文件：抽象层足够薄（协议路径 + dispatch 注入），分文件解耦没有必要。
 * 零工具注入：模型用通用工具操作 .memory/，protocol/ 为唯一真相源。
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "./commands/index.ts";
import { registerAutoModeHooks } from "./hooks/auto.ts";
import { createMainRunner } from "./agents/main.ts";

/** 协议手册默认位置：与扩展源码同目录。bun 按真实路径加载（软链解析后指向仓库 extension/），
 * protocol/ 随仓库分发，安装位与仓库分离后此路径依然成立。 */
const PROTOCOL_DIR = join(import.meta.dirname, "protocol");

/** 扩展运行时：共享状态与注入通道，依赖注入给命令与 agent，避免模块级全局变量 */
export class Runtime {
	/** 协议手册目录绝对路径：提示词据此指引模型阅读对应操作手册 */
	readonly protocolDir: string;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI, protocolDir: string = PROTOCOL_DIR) {
		this.pi = pi;
		this.protocolDir = protocolDir;
	}

	/** 注入一条用户消息唤醒模型干活（无 deliverAs：空闲时立即发送，触发新回合） */
	dispatch(prompt: string): void {
		void this.pi.sendUserMessage(prompt);
	}
}

/** 扩展工厂 */
export default function lazyMemoryExtension(pi: ExtensionAPI): void {
	const runtime = new Runtime(pi);
	registerMemoryCommands(pi, createMainRunner(runtime));
	registerAutoModeHooks(pi, runtime);
}