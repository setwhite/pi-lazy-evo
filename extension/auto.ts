/**
 * auto 自动挡：turn_end 水位触发后台任务（record 串行 + verify 批次）；
 * session_shutdown 会话边界全 reason 统一只尾部落盘（纯 IO）；session_start 发现尾部素材
 * 立即后台固化（record + verify）——与水位触发同一条 runAutoTasks 通道，因此两处都有 TUI 通知。
 * 任务语义与手动命令同一套（prompts.ts），通道不同：手动走主会话注入，自动走子进程。
 * 无管道通道：stdio 全 ignore + non-detached——子进程继承父控制台，Windows 上不弹新窗口；
 * detached 在 Windows 必弹新控制台（CREATE_NEW_CONSOLE，与 windowsHide 互斥），故不可用。
 * 防循环：水位增量触发；worker 在跑时吸收增量；compaction 回落重设基线。
 * ctx 生命周期：事件 ctx 在会话替换（new/resume/reload）后失效，不得跨 await 持有——
 * 处理器内只取纯值（cwd/transcript），通知走带 stale 兑底的闭包（guardNotify）。
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
}

/** 初始状态 */
export const INITIAL_AUTO_STATE: AutoState = { baselineTokens: 0, initialized: false, inFlight: false };

/** 是否存在未固化的会话尾部素材（空文件视为无） */
export function hasPendingTail(cwd: string): boolean {
	try {
		return readFileSync(join(memoryDir(cwd), PENDING_TAIL_FILE), "utf8").trim().length > 0;
	} catch {
		return false;
	}
}

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

/**
 * 带 stale 兑底的通知闭包：会话替换后 ctx 失效（任意属性访问即抛），
 * 通知失败降级为 console.error，不得让异常吞掉已落盘的固化结果。
 */
function guardNotify(ctx: ExtensionContext): (title: string, lines: string[]) => void {
	return (title, lines) => {
		try {
			notify(ctx, title, lines);
		} catch {
			console.error(`[pi-lazy-evo] ${title}\n${lines.join("\n")}`);
		}
	};
}

/** 挂载 auto 钩子：turn_end 水位触发 + session_start 冲刷尾部素材 */
export function registerAutoModeHooks(pi: ExtensionAPI, runtime: Runtime): void {
	let state: AutoState = { ...INITIAL_AUTO_STATE };
	pi.on("session_start", (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		// 上次会话边界的未固化尾部：新会话 ctx 新鲜，立即后台固化（不等水位线）；
		// 本次运行失败则 pending 保留，自然退回下次水位触发兑底
		if (state.inFlight || !hasPendingTail(ctx.cwd)) return;
		state = { ...state, inFlight: true };
		const cwd = ctx.cwd;
		const say = guardNotify(ctx);
		void runAutoTasks({ runtime, cwd, config, transcript: "", notify: say })
			.catch((error) => say("Memory Auto failed", [error instanceof Error ? error.message : String(error)]))
			.finally(() => {
				state = { ...state, inFlight: false };
			});
	});
	pi.on("turn_end", (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const decision = decideAutoTrigger(state, usage.tokens, config.autoWatermarkTokens);
		state = decision.state;
		if (!decision.trigger) return;
		state = { ...state, inFlight: true };
		// ctx 不得跨 await 持有：处理器内取纯值，通知走 stale 兑底闭包
		const cwd = ctx.cwd;
		const transcript = extractTranscript(ctx.sessionManager.getEntries());
		const say = guardNotify(ctx);
		void runAutoTasks({ runtime, cwd, config, transcript, notify: say })
			.catch((error) => say("Memory Auto failed", [error instanceof Error ? error.message : String(error)]))
			.finally(() => {
				state = { ...state, inFlight: false };
			});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		if (state.inFlight) return; // worker 正在固化同一份素材，跳过无损
		const transcript = extractTranscript(ctx.sessionManager.getEntries());
		if (!transcript.trim()) return;
		// 全 reason 统一：不在会话边界 spawn worker（主进程存活与 worker 执行都不可靠，Windows 控制台连坐；
		// 且冲刷的异步流程会撞上会话替换后的 ctx 失效），尾部全量落盘（纯 IO），
		// 下次 session_start 立即固化（带 TUI 通知）
		writePendingTail(ctx.cwd, transcript);
	});
}

/** 自动任务输入：纯值（不得携带 ctx，worker 异步流程跨 await）+ 通知回调 */
interface AutoTaskInput {
	runtime: Runtime;
	cwd: string;
	config: MemorySettings;
	transcript: string;
	/** 完成通知（处理器内构造的 stale 兑底闭包） */
	notify: (title: string, lines: string[]) => void;
}

// ---- 会话边界尾部落盘 ----

/** 未固化尾部暂存文件名（记忆库根目录下） */
const PENDING_TAIL_FILE = "pending.md";

/** 覆盖写会话尾部素材（session_shutdown 全 reason 调用；纯 IO，不依赖 worker 进程存活） */
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
 * 一次自动任务：record（当前会话 + 上次边界未固化尾部）→ verify（待验+待修正批次），
 * 两段分开快照 diff，汇总一条通知。transcript 可为空（启动冲刷只有尾部素材）。
 */
async function runAutoTasks({ runtime, cwd, config, transcript, notify: say }: AutoTaskInput): Promise<void> {
	ensureMemoryDir(cwd);
	const before = snapshotLibrary(cwd);
	// 素材 = 当前会话 + 上次会话边界的未固化尾部（若有，顺带消费）
	await runWorker("record", recordTask(collectTranscriptWithPending(cwd, transcript)), runtime.protocolDir, cwd, config, config.autoMemoTools);
	// record 成功后消费 pending；失败（抛错）自然保留，下次再试
	clearPendingTail(cwd);
	const mid = snapshotLibrary(cwd);
	const gated = gatedLibrary(cwd);
	const chunks = splitPending(toPending(selectPending(gated)));
	const results = await Promise.allSettled(chunks.map((chunk) => runWorker("verify", verifyTask(chunk), runtime.protocolDir, cwd, config, config.autoVerifyTools)));
	const recordChanges = diffLibrary(before, mid);
	const verifyChanges = diffLibrary(mid, snapshotLibrary(cwd));
	const failures = results
		.filter((r): r is PromiseRejectedResult => r.status === "rejected")
		.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
	const model = config.autoModel ? config.autoModel.id : "main model";
	const lines = [`record: ${formatChanges("record", recordChanges)}`, `verify×${chunks.length}: ${formatChanges("verify", verifyChanges)}`];
	if (failures.length > 0) lines.push(`${failures.length} failed: ${failures.join("; ")}`);
	say(`Memory Auto (${model})`, lines);
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
async function runWorker(kind: WorkerKind, task: AgentTask, protocolDir: string, cwd: string, config: MemorySettings, tools: string[]): Promise<void> {
	const promptContent = buildWorkerPrompt(task, protocolDir, cwd, config.autoMaxTurns);
	const built = buildAutoWorkerArgs({ model: config.autoModel, tools, promptContent });
	try {
		await spawnWorker({ command: built.command, args: built.args, cwd, timeoutMs: WORKER_TIMEOUT_MS });
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
			reject(new Error("worker timed out"));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(code === null ? "worker terminated externally" : `worker exited with code ${code}`));
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}