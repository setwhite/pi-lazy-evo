/**
 * lazy-memory 扩展入口：装配 Runtime 并注册命令（对齐 pi-observational-memory：
 * runtime 装配 → agents 执行层 → commands 注册；自动模式钩子将来在此挂载）。
 * Runtime 与入口同文件：抽象层足够薄（协议路径 + dispatch 注入），分文件解耦没有必要。
 * 零工具注入：模型用通用工具操作 .memory/，PROTOCOL.md 为唯一真相源。
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "./commands/index.ts";

/** 协议文档默认位置：与扩展源码同目录。bun 按真实路径加载（软链解析后指向仓库 extension/），
 * PROTOCOL.md 随仓库分发，安装位与仓库分离后此路径依然成立。 */
const PROTOCOL_PATH = join(import.meta.dirname, "PROTOCOL.md");

/** 扩展运行时：共享状态与注入通道，依赖注入给命令与 agent，避免模块级全局变量 */
export class Runtime {
	/** 协议文档绝对路径：提示词据此指引模型阅读（协议是 agent 的操作手册） */
	readonly protocolPath: string;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI, protocolPath: string = PROTOCOL_PATH) {
		this.pi = pi;
		this.protocolPath = protocolPath;
	}

	/** 注入一条用户消息唤醒模型干活（无 deliverAs：空闲时立即发送，触发新回合） */
	dispatch(prompt: string): void {
		void this.pi.sendUserMessage(prompt);
	}
}

/** 扩展工厂 */
export default function lazyMemoryExtension(pi: ExtensionAPI): void {
	registerMemoryCommands(pi, new Runtime(pi));
}