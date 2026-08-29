/**
 * auto 自动挡：turn_end 水位判定派发后台任务（record 串行 + verify 批次）；
 * session_shutdown 会话边界冲刷（new/resume 立即固化；quit/reload/fork 尾部落盘待下次合并）。
 * 任务语义与手动命令同一套（prompts.ts），通道不同：手动走主会话注入，自动走子进程。
 * 无管道通道：stdio 全 ignore + non-detached——子进程继承父控制台，Windows 上不弹新窗口；
 * detached 在 Windows 必弹新控制台（CREATE_NEW_CONSOLE，与 windowsHide 互斥），故不可用。
 * 防循环：水位增量触发；worker 在跑时吸收增量；compaction 回落重设基线。
 * 待验清单含 failed（修正流）：verify 批次里 failed 实体先修正文再复验，杜绝悬置。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWorkerPrompt, extractTranscript, recordTask, verifyTask, type AgentTask } from "./prompts.ts";
import { loadConfig, type AutoModel, type MemorySettings } from "./config.ts";
import { selectPending, toPending, type PendingEntity } from "./gate.ts";
import { diffLibrary, formatChanges, snapshotLibrary, type LibraryChanges, type WorkerKind } from "./library.ts";
import { ensureMemoryDir, memoryDir } from "./store.ts";
import { gatedLibrary } from "./deps.ts";
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
	/** 上次实际跑 worker 时的上下文 token（null = 从未跑过；冲刷节流的“刚固化过”标记） */
	lastRunTokens: number | null;
}

/** 初始状态 */
export const INITIAL_AUTO_STATE: AutoState = { baselineTokens: 0, initialized: false, inFlight: false, lastRunTokens: null };

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
	return { trigger: true, state: { ...state, baselineTokens: tokens, lastRunTokens: tokens } };
}

/**
 * 会话边界冲刷节流判定：上次固化点未知 / token 不可知 → 保守冲刷；
 * 距上次固化的增量不足（含 compact 回落为负）→ 素材刚固化或太少，跳过。
 */
export function shouldFlushOnShutdown(lastRunTokens: number | null, currentTokens: number | null, minTokens: number): boolean {
	if (lastRunTokens === null || currentTokens === null) return true;
	return currentTokens - lastRunTokens >= minTokens;
}

/** 挂载 auto 钩子：turn_end 水位触发 */
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
		void runAutoTasks({ runtime, ctx, config, transcript: extractTranscript(ctx.sessionManager.getEntries()) })
			.catch((error) => notify(ctx, "Memory Auto 失败", [error instanceof Error ? error.message : String(error)]))
			.finally(() => {
				state = { ...state, inFlight: false };
			});
	});
	pi.on("session_shutdown", (event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		if (state.inFlight) return; // worker 正在固化同一份素材，跳过无损
		const transcript = extractTranscript(ctx.sessionManager.getEntries());
		if (!transcript.trim()) return;
		// new / resume：主进程存活，节流通过则 spawn 立即固化（只 record，不连带 verify）
		if (event.reason === "new" || event.reason === "resume") {
			const tokens = ctx.getContextUsage()?.tokens ?? null;
			if (!shouldFlushOnShutdown(state.lastRunTokens, tokens, config.autoFlushMinTokens)) return;
			state = { ...state, inFlight: true, lastRunTokens: tokens ?? state.lastRunTokens ?? 0 };
			void runAutoTasks({ runtime, ctx, config, transcript, withVerify: false })
				.catch((error) => console.error("[pi-lazy-evo] 会话边界冲刷异常：", error))
				.finally(() => {
					state = { ...state, inFlight: false };
				});
			return;
		}
		// quit / reload / fork：主进程存活与 worker 执行都不可靠（Windows 控制台连坐），
		// 尾部全量落盘（纯 IO），下次任一 record（水位触发或冲刷）合并素材并消费
		writePendingTail(ctx.cwd, transcript);
	});
}

/** 自动任务输入：执行环境 + 会话素材 */
interface AutoTaskInput {
	runtime: Runtime;
	ctx: ExtensionContext;
	config: MemorySettings;
	transcript: string;
	/** 是否连带 verify：水位触发 true；会话边界冲刷 false（verify 只在水位触发跑） */
	withVerify?: boolean;
}

// ---- 会话边界尾部落盘 ----

/** 未固化尾部暂存文件名（记忆库根目录下） */
const PENDING_TAIL_FILE = "pending.md";

/** 覆盖写会话尾部素材（quit/reload/fork 时调用；纯 IO，不依赖 worker 进程存活） */
export function writePendingTail(cwd: string, transcript: string): void {
	const path = join(memoryDir(cwd), PENDING_TAIL_FILE);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, transcript, "utf8");
}

/** 合并未固化尾部到 record 素材（有则拼接；无则原样） */
export function collectTranscriptWithPending(cwd: string, transcript: string): string {
	let tail: string;
	try {
		tail = readFileSync(join(memoryDir(cwd), PENDING_TAIL_FILE), "utf8");
	} catch {
		return transcript;
	}
	return transcript ? `${transcript}\n\n[上一会话未固化尾部]\n${tail}` : tail;
}

/** 消费未固化尾部：record 成功后调用，失败（抛错）自然保留，下次再试 */
export function clearPendingTail(cwd: string): void {
	rmSync(join(memoryDir(cwd), PENDING_TAIL_FILE), { force: true });
}

/**
 * 一次自动任务：record（会话素材）→ verify（待验+待修正批次），两段分开快照 diff，汇总一条通知。
 * 冲刷（withVerify=false）只跑 record：会话边界的 verify 与当前会话无语境关联，留给水位触发。
 */
async function runAutoTasks({ runtime, ctx, config, transcript, withVerify = true }: AutoTaskInput): Promise<void> {
	ensureMemoryDir(ctx.cwd);
	const before = snapshotLibrary(ctx.cwd);
	// 素材 = 当前会话 + 上次会话边界的未固化尾部（若有，顺带消费）
	await runWorker("record", recordTask(collectTranscriptWithPending(ctx.cwd, transcript)), runtime.protocolDir, ctx, config, config.autoMemoTools);
	// record 成功后消费 pending；失败（抛错）自然保留，下次再试
	clearPendingTail(ctx.cwd);
	if (!withVerify) return;
	const mid = snapshotLibrary(ctx.cwd);
	const gated = gatedLibrary(ctx.cwd);
	const chunks = splitPending(toPending(selectPending(gated)));
	const results = await Promise.allSettled(chunks.map((chunk) => runWorker("verify", verifyTask(chunk), runtime.protocolDir, ctx, config, config.autoVerifyTools)));
	const recordChanges = diffLibrary(before, mid);
	const verifyChanges = diffLibrary(mid, snapshotLibrary(ctx.cwd));
	const failures = results
		.filter((r): r is PromiseRejectedResult => r.status === "rejected")
		.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
	const model = config.autoModel ? config.autoModel.id : "主模型";
	const lines = [`record：${formatChanges("record", recordChanges)}`, `verify×${chunks.length}：${formatChanges("verify", verifyChanges)}`];
	if (failures.length > 0) lines.push(`失败 ${failures.length} 个：${failures.join("；")}`);
	notify(ctx, `Memory Auto（${model}）`, lines);
}

// ---- worker 子进程通道 ----

/** worker 默认超时（毫秒）：防子进程卡死 */
const WORKER_TIMEOUT_MS = 10 * 60_000;

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
 * non-detached + unref + stdio 全 ignore：继承父控制台不弹窗（detached 在 Windows 必弹新控制台）；
 * 存活期有超时兜底（杀进程树）；worker 成败主进程不得而知——由调用方用文件系统快照 diff 判定。失败/超时以 reject 上报。
 */
async function spawnWorker(input: SpawnInput): Promise<void> {
	const { command, args, cwd, timeoutMs } = input;
	await new Promise<void>((resolve, reject) => {
		// non-detached：子进程继承父控制台，Windows 上不弹新窗口（detached 必弹新控制台）
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