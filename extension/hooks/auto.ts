/**
 * auto 自动挡：turn_end 时钟 + token 水位触发，串行 spawn 两个独立 pi 子进程（便宜模型）：
 * - 沉淀 worker：喂最近会话素材，按 record.md 提炼实体；
 * - 验证 worker：不带素材，按 verify.md 核对 unverified/stale 实体。
 * 均为独立上下文，自带通用工具按协议手册操作 .memory/——与手动模式同一执行哲学（扩展不代写库）。
 * 防循环：水位增量触发；worker 在跑时吸收增量不重复触发；compaction 回落重设基线。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AutoModel, type MemorySettings } from "../core/config.ts";
import type { Runtime } from "../index.ts";
import { notify } from "../tools/notify.ts";

/** worker 默认超时（毫秒）：防子进程卡死 */
const WORKER_TIMEOUT_MS = 10 * 60_000;
/** 喂给沉淀 worker 的最近会话条目上限 */
const TRANSCRIPT_ENTRY_LIMIT = 30;
/** 每条消息文本截断长度 */
const MESSAGE_TEXT_MAX = 2_000;

/** auto 触发状态机（闭包持有，非模块级全局） */
export interface AutoState {
	/** 上次基线：会话累计上下文 token */
	baselineTokens: number;
	/** 是否已吸收首次基线 */
	initialized: boolean;
	/** 是否有 worker 在跑 */
	inFlight: boolean;
}

/** 触发判定结果：是否触发 + 推进后的状态 */
export interface AutoDecision {
	trigger: boolean;
	state: AutoState;
}

/** 初始状态 */
export const INITIAL_AUTO_STATE: AutoState = { baselineTokens: 0, initialized: false, inFlight: false };

/**
 * 纯判定：给定状态与当前累计 token，水位增量是否足以触发一次自动沉淀。
 * - 首次观察吸收基线不触发；compaction（tokens 回落）重设基线不触发；
 * - 增量未达阈值不触发；worker 在跑时吸收增量（结束后不重复触发）。
 */
export function decideAutoTrigger(state: AutoState, tokens: number, watermarkTokens: number): AutoDecision {
	if (!state.initialized) return { trigger: false, state: { ...state, baselineTokens: tokens, initialized: true } };
	if (tokens < state.baselineTokens) return { trigger: false, state: { ...state, baselineTokens: tokens } };
	if (tokens - state.baselineTokens < watermarkTokens) return { trigger: false, state };
	if (state.inFlight) return { trigger: false, state: { ...state, baselineTokens: tokens } };
	return { trigger: true, state: { ...state, baselineTokens: tokens } };
}

/** 会话条目最小结构：只取 type 与可选 message（与 pi 的 SessionEntry 结构兼容） */
export interface TranscriptEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** 从会话抽取最近的对话素材（text 块拼合、逐条截断）——只喂给沉淀 worker */
export function extractTranscript(entries: readonly TranscriptEntry[], limit = TRANSCRIPT_ENTRY_LIMIT): string {
	const messages = entries
		.filter((e) => e.type === "message" && e.message)
		.slice(-limit)
		.map((e) => {
			const m = e.message!;
			return `${m.role ?? "unknown"}: ${messageText(m.content)}`.slice(0, MESSAGE_TEXT_MAX);
		});
	return messages.join("\n\n");
}

/** 消息 content 提取纯文本（兼容字符串与 block 数组） */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text?: unknown } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
			.map((b) => (typeof b.text === "string" ? b.text : ""))
			.join("");
	}
	return "";
}

/** 共同尾部：记忆库根 + 约束（格式文件/操作手册引用由各 worker 提示词自含，互不越界） */
function promptHeader(cwd: string, maxTurns: number): string[] {
	return [
		`- 记忆库根目录：${cwd}/.memory（用绝对路径操作）。`,
		`- 约束：最多 ${maxTurns} 轮精简执行；不改 .memory/ 以外的文件；结束后用一句话总结做了什么。`,
	];
}

/** 沉淀 worker 提示词：只做提炼（record），带会话素材，只需实体面 */
export function buildMemoWorkerPrompt(input: { protocolDir: string; cwd: string; transcript: string; maxTurns: number }): string {
	return [
		"你是 lazy-memory 的后台记忆沉淀代理，任务是在 headless 环境里操作 .memory/ 记忆库。",
		`- 协议手册：先读 ${input.protocolDir}/entities.md（实体格式），再按 ${input.protocolDir}/record.md 执行。`,
		"- 任务：从下面给的最近对话素材里提炼长期稳定事实；用 grep 对照 .memory/entities/ 已有实体判定新增/更新；sources 追加用 ； 分隔不重复。只写值得日后引用的结论。",
		...promptHeader(input.cwd, input.maxTurns),
		"",
		"=== 最近对话素材（供沉淀提炼）===",
		input.transcript || "（无可用素材）",
	].join("\n");
}

/** 验证 worker 提示词：只做验证（verify），不带素材，读实体面 + 验证面 */
export function buildVerifyWorkerPrompt(input: { protocolDir: string; cwd: string; maxTurns: number }): string {
	return [
		"你是 lazy-memory 的后台验证代理，任务是在 headless 环境里操作 .memory/ 记忆库。",
		`- 协议手册：先读 ${input.protocolDir}/entities.md（读实体用）与 ${input.protocolDir}/verifications.md（验证记录/验证器/门控），再按 ${input.protocolDir}/verify.md 执行。`,
		"- 任务：找出 .memory/ 里 unverified 或 stale 的实体（无验证记录、或正文自上次验证后被修改），逐条核对并按协议追加验证记录（evidence 必填，只追加不覆盖）。",
		"- 涉及时效性/外部可查事实时，可用联网检索做 web-research 验证（若工具可用）；本地可核对的用 format/conflict/local-evidence。",
		...promptHeader(input.cwd, input.maxTurns),
	].join("\n");
}

/** 组装子进程调用参数与提示词内容（纯函数，可测；spawn 由调用方执行） */
export function buildAutoWorkerArgs(input: { model?: AutoModel; tools: string[]; promptContent: string }): { command: string; args: string[]; promptFile: string; promptDir: string } {
	const promptDir = mkdtempSync(join(tmpdir(), "lazy-memory-auto-"));
	const promptFile = join(promptDir, "worker.md");
	writeFileSync(promptFile, input.promptContent, "utf8");
	const args = ["--mode", "json", "-p", "--no-session"];
	if (input.model) {
		args.push("--model", `${input.model.provider}/${input.model.id}`);
		args.push("--thinking", input.model.thinking ?? "low");
	} else {
		args.push("--thinking", "low");
	}
	args.push("--tools", input.tools.join(","), "--append-system-prompt", promptFile);
	args.push("Task: 请执行上述后台任务。");
	return { command: "pi", args, promptFile, promptDir };
}

/** 挂载 auto 钩子：turn_end + 水位判定 + 状态机 */
export function registerAutoModeHooks(pi: ExtensionAPI, runtime: Runtime): void {
	let state: AutoState = { ...INITIAL_AUTO_STATE };
	pi.on("turn_end", (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const decision = decideAutoTrigger(state, usage.tokens, config.autoWatermarkTokens);
		state = decision.state;
		if (!decision.trigger) return;
		state = { ...state, inFlight: true };
		void runAutoWorker(runtime, ctx, config).finally(() => {
			state = { ...state, inFlight: false };
		});
	});
}

/** 串行执行：先沉淀、后验证，各自通知结果 */
async function runAutoWorker(runtime: Runtime, ctx: ExtensionContext, config: MemorySettings): Promise<void> {
	const transcript = extractTranscript(ctx.sessionManager.getEntries());
	const memoPrompt = buildMemoWorkerPrompt({ protocolDir: runtime.protocolDir, cwd: ctx.cwd, transcript, maxTurns: config.autoMaxTurns });
	await runSingleWorker("沉淀", runtime, ctx, config, config.autoMemoTools, memoPrompt);
	const verifyPrompt = buildVerifyWorkerPrompt({ protocolDir: runtime.protocolDir, cwd: ctx.cwd, maxTurns: config.autoMaxTurns });
	await runSingleWorker("验证", runtime, ctx, config, config.autoVerifyTools, verifyPrompt);
}

/** 跑单个 worker：写提示词 → spawn → 通知结果 → 清理临时目录 */
async function runSingleWorker(kind: string, runtime: Runtime, ctx: ExtensionContext, config: MemorySettings, tools: string[], promptContent: string): Promise<void> {
	const built = buildAutoWorkerArgs({ model: config.autoModel, tools, promptContent });
	try {
		const summary = await spawnWorker(built.command, built.args, ctx.cwd, WORKER_TIMEOUT_MS);
		const model = config.autoModel ? config.autoModel.id : "主模型";
		notify(ctx, `Memory Auto·${kind}（${model}）`, [summary]);
	} catch (error) {
		notify(ctx, `Memory Auto·${kind} 失败`, [error instanceof Error ? error.message : String(error)]);
	} finally {
		rmSync(built.promptDir, { recursive: true, force: true });
	}
}

/** spawn pi 子进程（headless），收集输出返回最终 assistant 文本 */
async function spawnWorker(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		let lastAssistant = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error("worker 超时"));
		}, timeoutMs);
		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
					if (event.type === "message_end" && event.message?.role === "assistant") {
						const text = messageText(event.message.content).trim();
						if (text) lastAssistant = text;
					}
				} catch {
					// 非 JSON 行忽略（如日志）
				}
			}
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(lastAssistant || "已执行（无文本输出）");
			} else {
				reject(new Error(`worker 退出码 ${code}${stderr ? `：${stderr.slice(0, 200)}` : ""}`));
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
