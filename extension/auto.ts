/**
 * auto 自动挡：turn_end 时钟 + token 水位判定，串行派发两个后台任务（record→verify）。
 * 任务语义与手动命令同一套（prompts.ts），通道不同：手动走主会话注入，自动走子进程。
 * 防循环：水位增量触发；worker 在跑时吸收增量；compaction 回落重设基线。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWorkerPrompt, extractTranscript, recordTask, verifyTask, type AgentTask } from "./prompts.ts";
import { loadConfig, type AutoModel, type MemorySettings } from "./config.ts";
import { gateLibrary, selectPending, toPending } from "./gate.ts";
import { ensureMemoryDir, listEntities, listVerifications, readLibrary } from "./store.ts";
import { messageText, notify } from "./utils.ts";
import type { Runtime } from "./index.ts";

// ---- 水位触发判定 ----

/** auto 触发状态机（闭包持有，非模块级全局） */
export interface AutoState {
	/** 上次基线：会话累计上下文 token */
	baselineTokens: number;
	/** 是否已吸收首次基线 */
	initialized: boolean;
	/** 是否有 worker 在跑 */
	inFlight: boolean;
}

/** 初始状态 */
export const INITIAL_AUTO_STATE: AutoState = { baselineTokens: 0, initialized: false, inFlight: false };

/**
 * 纯判定：给定状态与当前累计 token，水位增量是否足以触发一次自动任务。
 * 首次观察吸收基线不触发；compaction（tokens 回落）重设基线不触发；
 * 增量未达阈值不触发；worker 在跑时吸收增量（结束后不重复触发）。
 */
export function decideAutoTrigger(state: AutoState, tokens: number, watermarkTokens: number): { trigger: boolean; state: AutoState } {
	if (!state.initialized) return { trigger: false, state: { ...state, baselineTokens: tokens, initialized: true } };
	if (tokens < state.baselineTokens) return { trigger: false, state: { ...state, baselineTokens: tokens } };
	if (tokens - state.baselineTokens < watermarkTokens) return { trigger: false, state };
	if (state.inFlight) return { trigger: false, state: { ...state, baselineTokens: tokens } };
	return { trigger: true, state: { ...state, baselineTokens: tokens } };
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

/** 串行派发：先 record（带会话素材），后 verify（算好待验清单注入） */
async function runAutoWorker(runtime: Runtime, ctx: ExtensionContext, config: MemorySettings): Promise<void> {
	ensureMemoryDir(ctx.cwd);
	const record = recordTask(extractTranscript(ctx.sessionManager.getEntries()));
	await runWorkerTask("record", record, runtime.protocolDir, ctx, config, config.autoMemoTools);
	const pending = selectPending(gateLibrary(readLibrary(ctx.cwd)));
	const verify = verifyTask(toPending(pending));
	await runWorkerTask("verify", verify, runtime.protocolDir, ctx, config, config.autoVerifyTools);
}

// ---- worker 子进程通道 ----

/** worker 任务类型：record 只写实体，verify 只追加验证记录 */
export type WorkerKind = "record" | "verify";

/** worker 默认超时（毫秒）：防子进程卡死 */
const WORKER_TIMEOUT_MS = 10 * 60_000;

/** 库快照：实体 id→mtime + 验证记录文件名→(target,result)，供 worker 前后 diff */
export interface LibrarySnapshot {
	entityMtimes: Map<string, number>;
	verifications: Map<string, { target: string; result: "passed" | "failed" }>;
}

/** 变化摘要：实体新增/更新 + 新增验证记录 */
export interface LibraryChanges {
	addedEntities: string[];
	updatedEntities: string[];
	newVerifications: { id: string; result: "passed" | "failed" }[];
}

/** 快照当前库：实体 mtime + 验证记录文件（纯 IO，无副作用） */
export function snapshotLibrary(cwd: string): LibrarySnapshot {
	return {
		entityMtimes: new Map(listEntities(cwd).map((m) => [m.id, m.mtimeMs])),
		verifications: new Map(listVerifications(cwd).map((v) => [basename(v.path), { target: v.target, result: v.result }])),
	};
}

/** 前后快照对比：实体新增/更新 + 新增验证记录（实体删除不报） */
export function diffLibrary(before: LibrarySnapshot, after: LibrarySnapshot): LibraryChanges {
	const addedEntities = [...after.entityMtimes.keys()].filter((id) => !before.entityMtimes.has(id));
	const updatedEntities = [...after.entityMtimes.entries()]
		.filter(([id, mtime]) => {
			const prev = before.entityMtimes.get(id);
			return prev !== undefined && prev !== mtime;
		})
		.map(([id]) => id);
	const newVerifications = [...after.verifications.entries()]
		.filter(([file]) => !before.verifications.has(file))
		.map(([, v]) => ({ id: v.target.replace(/^entities\//, "").replace(/\.md$/, ""), result: v.result }));
	return { addedEntities, updatedEntities, newVerifications };
}

/** 通知文案策略表：kind → 格式化函数（无变化统一返回"无变化"） */
const FORMATTERS: Record<WorkerKind, (changes: LibraryChanges) => string> = {
	record: (c) => {
		const parts: string[] = [];
		if (c.addedEntities.length) parts.push(`+ ${c.addedEntities.join(", ")}`);
		if (c.updatedEntities.length) parts.push(`~ ${c.updatedEntities.join(", ")}`);
		return parts.length ? parts.join("　") : "无变化";
	},
	verify: (c) => {
		if (!c.newVerifications.length) return "无变化";
		const list = c.newVerifications.map((v) => `${v.id} ${v.result === "passed" ? "✅" : "⚠️"}`).join(", ");
		return `+ 验证：${list}`;
	},
};

/** 变化清单 → 一行通知文本 */
export function formatChanges(kind: WorkerKind, changes: LibraryChanges): string {
	return FORMATTERS[kind](changes);
}

/** 组装子进程调用参数并落盘提示词文件（参数组装可测；spawn 由调用方执行） */
export function buildAutoWorkerArgs(input: { model?: AutoModel; tools: string[]; promptContent: string }): { command: string; args: string[]; promptFile: string; promptDir: string } {
	const promptDir = mkdtempSync(join(tmpdir(), "pi-lazy-evo-auto-"));
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
	args.push("任务：请执行上述后台任务。");
	return { command: "pi", args, promptFile, promptDir };
}

/** 跑一个后台任务：拼提示词 → 快照 → spawn → diff 通知 → 清理临时目录 */
export async function runWorkerTask(kind: WorkerKind, task: AgentTask, protocolDir: string, ctx: ExtensionContext, config: MemorySettings, tools: string[]): Promise<void> {
	const promptContent = buildWorkerPrompt(task, protocolDir, ctx.cwd, config.autoMaxTurns);
	const built = buildAutoWorkerArgs({ model: config.autoModel, tools, promptContent });
	try {
		const before = snapshotLibrary(ctx.cwd);
		await spawnWorker({ command: built.command, args: built.args, cwd: ctx.cwd, timeoutMs: WORKER_TIMEOUT_MS, maxTurns: config.autoMaxTurns });
		const changes = diffLibrary(before, snapshotLibrary(ctx.cwd));
		const model = config.autoModel ? config.autoModel.id : "主模型";
		notify(ctx, `Memory Auto·${kind}（${model}）`, [formatChanges(kind, changes)]);
	} catch (error) {
		notify(ctx, `Memory Auto·${kind} 失败`, [error instanceof Error ? error.message : String(error)]);
	} finally {
		rmSync(built.promptDir, { recursive: true, force: true });
	}
}

/** spawn 参数（内部）：命令/参数/工作目录/超时/轮数上限 */
interface SpawnInput {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxTurns: number;
}

/** spawn pi 子进程（headless），收集输出返回最终 assistant 文本。
 * 轮数上限是硬约束：数 assistant message_end 事件，达到 maxTurns 立即 SIGKILL。 */
async function spawnWorker(input: SpawnInput): Promise<string> {
	const { command, args, cwd, timeoutMs, maxTurns } = input;
	return await new Promise<string>((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		let lastAssistant = "";
		let assistantTurns = 0;
		let hitLimit = false;
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
						assistantTurns++;
						const text = messageText(event.message.content).trim();
						if (text) lastAssistant = text;
						if (assistantTurns >= maxTurns) {
							hitLimit = true;
							proc.kill("SIGKILL"); // 轮数上限：硬约束，不再给子进程开口机会
						}
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
			if (code !== 0) {
				reject(new Error(`worker 退出码 ${code}${stderr ? `：${stderr.slice(0, 200)}` : ""}`));
				return;
			}
			const fallback = hitLimit ? "已达轮数上限（无文本输出）" : "已执行（无文本输出）";
			resolve(lastAssistant || fallback);
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}