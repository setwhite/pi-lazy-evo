/**
 * pi-lazy-evo 扩展入口：装配 Runtime（协议路径 + 派发通道 + 会话 cwd）并注册 /memory 命令。
 * 零工具注入：模型用通用工具（grep/read/write/bash）按 protocol 手册操作 .memory/。
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "./commands.ts";

/** 协议手册目录：与扩展源码同目录。bun 按真实路径加载（软链解析后指向仓库 extension/），
 * protocol/ 随仓库分发，安装位与仓库分离后此路径依然成立。 */
const PROTOCOL_DIR = join(import.meta.dirname, "protocol");

/** 扩展运行时：协议目录 + 会话 cwd + 注入通道，依赖注入给命令，避免模块级全局变量 */
export class Runtime {
	/** 协议手册目录绝对路径：提示词据此指引模型阅读对应操作手册 */
	readonly protocolDir: string;
	/** 当前会话工作目录：session_start 捕获，供补全读库（如 verify 的实体 id 候选） */
	cwd: string | undefined;
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
	pi.on("session_start", (_event, ctx) => {
		runtime.cwd = ctx.cwd;
	});
	registerMemoryCommands(pi, runtime);
}