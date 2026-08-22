/**
 * Runtime：扩展共享状态与注入通道（对齐 pi-observational-memory 的 Runtime 模式）。
 * 目前持有 pi 引用与协议文档路径；自动模式（turn_end 时钟）的
 * token 水位与 in-flight 锁将来在此扩展，命令与钩子共用同一实例。
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 协议文档默认位置：与扩展源码同目录。bun 按真实路径加载（软链解析后指向仓库 extension/），
 * PROTOCOL.md 随仓库分发，安装位与仓库分离后此路径依然成立。 */
const PROTOCOL_PATH = join(import.meta.dirname, "PROTOCOL.md");

/** 扩展运行时：依赖注入给命令与 agent，避免模块级全局变量 */
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
		this.pi.sendUserMessage(prompt);
	}
}