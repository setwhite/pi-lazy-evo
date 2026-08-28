/**
 * auto 自动挡：turn_end 水位判定派发后台任务（record 串行 + verify 批次）；session_shutdown 尾部冲刷复用同一执行体。
 * 任务语义与手动命令同一套（prompts.ts），通道不同：手动走主会话注入，自动走子进程。
 * 无管道通道：stdio 全 ignore + non-detached——子进程继承父控制台，Windows 上不弹新窗口；
 * detached 在 Windows 必弹新控制台（CREATE_NEW_CONSOLE，与 windowsHide 互斥），故不可用。
 * 防循环：水位增量触发；worker 在跑时吸收增量；compaction 回落重设基线；lastRunTokens 节流冲刷。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWorkerPrompt, extractTranscript, recordTask, verifyTask, type AgentTask } from "./prompts.ts";
import { loadConfig, type AutoModel, type MemorySettings } from "./config.ts";
import { gateLibrary, selectPending, toPending, type PendingEntity } from "./gate.ts";
import { ensureMemoryDir, listEntities, listVerifications, readLibrary } from "./store.ts";
import { notify } from "./utils.ts";
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
	/** 上次实际跑 worker 时的上下文 tokens（null = 从未跑过；shutdown 冲刷节流依据） */
	lastRunTokens: number | null;
}

/** 初始状态 */
export const INITIAL_AUTO_STATE: AutoState = { baselineTokens: 0, initialized: false, inFlight: false, lastRunTokens: null };

/**
 * 纯判定：给定状态与当前累计 token，水位增量是否足以触发一次自动任务。
 * 首次观察吸收基线不触发；compaction（tokens 回落）重设基线不触发；
 * 增量未达阈值不触发；worker 在跑时吸收增量（结束后不重复触发）；
 * 触发推进 lastRunTokens（shutdown 节流的"刚跑过"标记）。
 */
export function decideAutoTrigger(state: AutoState, tokens: number, watermarkTokens: number): { trigger: boolean; state: AutoState } {
	if (!state.initialized) return { trigger: false, state: { ...state, baselineTokens: tokens, initialized: true } };
	if (tokens < state.baselineTokens) return { trigger: false, state: { ...state, baselineTokens: tokens } };
	if (tokens - state.baselineTokens < watermarkTokens) return { trigger: false, state };
	if (state.inFlight) return { trigger: false, state: { ...state, baselineTokens: tokens } };
	return { trigger: true, state: { ...state, baselineTokens: tokens, lastRunTokens: tokens } };
}

/** shutdown 冲刷节流阈值：距上次实际任务的增量低于该值不冲刷（素材刚固化或太少） */
const AUTO_FLUSH_MIN_TOKENS = 8_000;

/**
 * shutdown 冲刷判定：从未跑过 / token 不可知 → 保守冲刷；增量不足 → 素材刚固化或太少，跳过。
 */
export function shouldFlushOnShutdown(lastRunTokens: number | null, currentTokens: number | null, minTokens: number): boolean {
	if (lastRunTokens === null || currentTokens === null) return true;
	return currentTokens - lastRunTokens >= minTokens;
}

/** 挂载 auto 钩子：turn_end 水位触发与 session_shutdown 尾部冲刷共用 runAutoTasks */
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
		void runAutoTasks(runtime, ctx, config, {
			transcript: extractTranscript(ctx.sessionManager.getEntries()),
			verifyConcurrency: MAX_VERIFY_CONCURRENCY,
			notify: true,
		})
			.catch((error) => notify(ctx, "Memory Auto 失败", [error instanceof Error ? error.message : String(error)]))
			.finally(() => {
				state = { ...state, inFlight: false };
			});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		if (state.inFlight) return; // turn_end worker 正在固化同一份素材（无新回合），跳过无损
		// 尾部冲刷：不 await（主进程退出不连带杀子进程）；素材非空才值得派发
		const transcript = extractTranscript(ctx.sessionManager.getEntries());
		if (!transcript.trim()) return;
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		// 节流：从未跑过 / token 不可知 → 保守冲刷；增量不足 → 素材刚固化或太少，跳过
		if (!shouldFlushOnShutdown(state.lastRunTokens, tokens, AUTO_FLUSH_MIN_TOKENS)) return;
		state = { ...state, inFlight: true, lastRunTokens: tokens ?? state.lastRunTokens ?? 0 };
		void runAutoTasks(runtime, ctx, config, { transcript, verifyConcurrency: 1, notify: false })
			.catch((error) => console.error("[pi-lazy-evo] shutdown 冲刷异常：", error))
			.finally(() => {
				state = { ...state, inFlight: false };
			});
	});
}

/** 自动任务执行参数：会话素材 + verify 并发上限 + 是否通知（shutdown 静默） */
interface AutoTaskOptions {
	transcript: string;
	verifyConcurrency: number;
	notify: boolean;
}

/**
 * 一次自动任务：record（会话素材）→ verify（待验批次）。
 * turn_end（并发 8 / 通知）与 session_shutdown（串行 1 / 静默）共用；notify 时两段分开快照 diff，汇总一条通知。
 */
async function runAutoTasks(runtime: Runtime, ctx: ExtensionContext, config: MemorySettings, options: AutoTaskOptions): Promise<void> {
	ensureMemoryDir(ctx.cwd);
	const before = options.notify ? snapshotLibrary(ctx.cwd) : null;
	await runWorker("record", recordTask(options.transcript), runtime.protocolDir, ctx, config, config.autoMemoTools);
	const mid = options.notify ? snapshotLibrary(ctx.cwd) : null;
	const chunks = splitPending(toPending(selectPending(gateLibrary(readLibrary(ctx.cwd)))), options.verifyConcurrency);
	const results = await Promise.allSettled(chunks.map((chunk) => runWorker("verify", verifyTask(chunk), runtime.protocolDir, ctx, config, config.autoVerifyTools)));
	if (!options.notify) return;
	const recordChanges = diffLibrary(before!, mid!);
	const verifyChanges = diffLibrary(mid!, snapshotLibrary(ctx.cwd));
	const failures = results
		.filter((r): r is PromiseRejectedResult => r.status === "rejected")
		.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
	const model = config.autoModel ? config.autoModel.id : "主模型";
	const lines = [`record：${formatChanges("record", recordChanges)}`, `verify×${chunks.length}：${formatChanges("verify", verifyChanges)}`];
	if (failures.length > 0) lines.push(`失败 ${failures.length} 个：${failures.join("；")}`);
	notify(ctx, `Memory Auto（${model}）`, lines);
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
	const args = ["-p", "--no-session"];
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

/** 并发上限：verify 批次同时最多 N 个 worker */
const MAX_VERIFY_CONCURRENCY = 8;

/** 待验清单切块：块数 ≤ 并发上限（每块 ceil(n/块数)），空清单返回空数组 */
export function splitPending(pending: PendingEntity[], maxWorkers: number = MAX_VERIFY_CONCURRENCY): PendingEntity[][] {
	const total = pending.length;
	if (total === 0) return [];
	const workers = Math.min(total, maxWorkers);
	const size = Math.ceil(total / workers);
	const chunks: PendingEntity[][] = [];
	for (let i = 0; i < total; i += size) chunks.push(pending.slice(i, i + size));
	return chunks;
}

/** 单任务 spawn（record / verify 共用）：拼提示词 → spawn → 清理临时目录 */
async function runWorker(kind: WorkerKind, task: AgentTask, protocolDir: string, ctx: ExtensionContext, config: MemorySettings, tools: string[]): Promise<void> {
	const promptContent = buildWorkerPrompt(task, protocolDir, ctx.cwd, config.autoMaxTurns);
	const built = buildAutoWorkerArgs({ model: config.autoModel, tools, promptContent });
	try {
		await spawnWorker({ command: built.command, args: built.args, cwd: ctx.cwd, timeoutMs: WORKER_TIMEOUT_MS });
	} finally {
		rmSync(built.promptDir, { recursive: true, force: true });
	}
}

/** spawn 参数（内部）：命令/参数/工作目录/超时（无管道通道，无事件流解析） */
interface SpawnInput {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
}

/**
 * 终止 worker 进程树：Windows 用 taskkill /T；其余平台按进程组 SIGKILL。
 * 失败静默：worker 靠提示词轮数约束自行收尾。
 */
function killWorkerTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
		} catch {
			// taskkill 不可用或失败：放弃
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 进程已退出
		}
	}
}

/**
 * spawn pi 子进程（headless，无管道通道）。
 * non-detached + unref + stdio 全 ignore：继承父控制台不弹窗；主进程退出不连带杀子进程（除非控制台关闭），
 * 存活期有超时兜底（杀进程树）；worker 成败主进程不得而知——由调用方用文件系统快照 diff 判定。失败/超时以 reject 上报。
 */
async function spawnWorker(input: SpawnInput): Promise<void> {
	const { command, args, cwd, timeoutMs } = input;
	await new Promise<void>((resolve, reject) => {
		// non-detached：Windows 上 detached 必弹新控制台（与 windowsHide 互斥），放弃孤儿化换无窗口
		const proc = spawn(command, args, { cwd, shell: false, stdio: "ignore", windowsHide: true });
		proc.unref();
		const timer = setTimeout(() => {
			if (proc.pid) killWorkerTree(proc.pid); // 主进程存活时的超时兜底
			reject(new Error("worker 超时"));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(code === null ? "worker 被外部终止" : `worker 退出码 ${code}`));
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}