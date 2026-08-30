/**
 * auto 自动挡：turn_end 水位触发自动任务（record 串行 + verify 一实体一 worker，增量范围）；
 * session_shutdown 落盘会话尾部素材，session_start 发现尾部立即固化——两条触发通道同一套 runAutoTasks。
 * 任务语义来自 prompts.ts；子进程通道来自 worker.ts（--mode json 事件流 → TUI 活动面板，实时可见）。
 * 防循环：水位增量触发；worker 在跑时吸收增量；compaction 回落重设基线。
 * ctx 生命周期：事件 ctx 在会话替换（new/resume/reload）后失效，不得跨 await 持有——
 * 处理器内只取纯值（cwd/transcript），通知与活动面板走 stale 兑底闭包（guardNotify / guardActivity）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractTranscript, recordTask, verifyTask } from "./prompts.ts";
import { loadConfig, type MemorySettings } from "./config.ts";
import { selectPending, toPending, type GatedEntity, type PendingEntity } from "./gate.ts";
import { diffLibrary, formatChanges, snapshotLibrary, type LibraryChanges } from "./library.ts";
import {
	clearPendingTail,
	collectTranscriptWithPending,
	ensureMemoryDir,
	hasPendingTail,
	writePendingTail,
} from "./store.ts";
import { gatedLibrary } from "./deps.ts";
import { ActivityPanel, runWorker } from "./worker.ts";
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

/**
 * 纯判定：auto 挡钩子是否对本次运行生效。
 * worker 子进程（`pi --mode json` / `-p`）同样加载本扩展并完整走完 session 生命周期，
 * 且与宿主共用同一记忆库目录；若照常触发：session_start 见到 pending.md 会再 spawn 一个
 * worker（无界递归），session_shutdown 会把 worker 自己的转录写进 pending.md（覆盖宿主素材）。
 * 自动沉淀只属于长生命周期的交互会话，一次性无头模式一律不参与。
 */
export function autoHooksEnabled(mode: string): boolean {
	return mode !== "json" && mode !== "print";
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

/** 活动面板推送闭包（编辑器上方 widget）：worker 事件实时刷新，ctx stale 后静默丢弃 */
function guardActivity(ctx: ExtensionContext): (lines: string[] | undefined) => void {
	return (lines) => {
		try {
			ctx.ui.setWidget("pi-lazy-evo", lines);
		} catch {
			// 会话已替换：瞬时活动展示丢失可容忍
		}
	};
}

/** 挂载 auto 钩子：turn_end 水位触发 + session_start 冲刷尾部素材 */
export function registerAutoModeHooks(pi: ExtensionAPI, runtime: Runtime): void {
	let state: AutoState = { ...INITIAL_AUTO_STATE };
	pi.on("session_start", (_event, ctx) => {
		if (!autoHooksEnabled(ctx.mode)) return;
		const activity = guardActivity(ctx);
		activity(undefined); // 清掉上次会话可能残留的 worker 活动行
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		// 上次会话边界的未固化尾部：新会话 ctx 新鲜，立即固化（不等水位线）；
		// 本次运行失败则 pending 保留，自然退回下次水位触发兑底
		if (state.inFlight || !hasPendingTail(ctx.cwd)) return;
		state = { ...state, inFlight: true };
		const cwd = ctx.cwd;
		const say = guardNotify(ctx);
		void runAutoTasks({ runtime, cwd, config, transcript: "", notify: say, activity })
			.catch((error) => say("Memory Auto failed", [error instanceof Error ? error.message : String(error)]))
			.finally(() => {
				state = { ...state, inFlight: false };
			});
	});
	pi.on("turn_end", (_event, ctx) => {
		if (!autoHooksEnabled(ctx.mode)) return;
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const decision = decideAutoTrigger(state, usage.tokens, config.autoWatermarkTokens);
		state = decision.state;
		if (!decision.trigger) return;
		state = { ...state, inFlight: true };
		// ctx 不得跨 await 持有：处理器内取纯值，通知/面板走 stale 兑底闭包
		const cwd = ctx.cwd;
		const transcript = extractTranscript(ctx.sessionManager.getEntries());
		const say = guardNotify(ctx);
		void runAutoTasks({ runtime, cwd, config, transcript, notify: say, activity: guardActivity(ctx) })
			.catch((error) => say("Memory Auto failed", [error instanceof Error ? error.message : String(error)]))
			.finally(() => {
				state = { ...state, inFlight: false };
			});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (!autoHooksEnabled(ctx.mode)) return;
		const config = loadConfig(ctx.cwd);
		if (config.mode !== "auto") return;
		if (state.inFlight) return; // worker 正在固化同一份素材，跳过无损
		const transcript = extractTranscript(ctx.sessionManager.getEntries());
		if (!transcript.trim()) return;
		// 会话边界不 spawn worker：冲刷的异步流程会撞上会话替换后的 ctx 失效。
		// 尾部全量落盘（纯 IO），下次 session_start 立即固化（带活动面板与通知）
		writePendingTail(ctx.cwd, transcript);
	});
}

/** 自动任务输入：纯值（不得携带 ctx，worker 异步流程跨 await）+ 通知/活动面板回调 */
interface AutoTaskInput {
	runtime: Runtime;
	cwd: string;
	config: MemorySettings;
	transcript: string;
	/** 完成通知（stale 兑底闭包） */
	notify: (title: string, lines: string[]) => void;
	/** 活动面板推送（stale 兑底闭包；undefined 清除） */
	activity: (lines: string[] | undefined) => void;
}

// ---- 自动任务编排 ----

/** 一次自动任务：record（当前会话 + 未固化尾部）→ verify（本轮新增/更新的实体，一实体一 worker），
 * 每个 worker 在活动面板占一行，全程结束后汇总一条通知。
 * 只清增量债：存量积压不自动重验（防 O(积压) 成本与无限重验），汇总通知里提醒手动 /memory verify all 清账。
 * transcript 可为空（启动冲刷只有尾部素材）。
 */
async function runAutoTasks({ runtime, cwd, config, transcript, notify: say, activity }: AutoTaskInput): Promise<void> {
	ensureMemoryDir(cwd);
	const panel = new ActivityPanel(activity);
	const before = snapshotLibrary(cwd);
	const base = { protocolDir: runtime.protocolDir, cwd, config, panel };
	await runWorker({ ...base, kind: "record", rowId: "record", task: recordTask(collectTranscriptWithPending(cwd, transcript)) });
	clearPendingTail(cwd); // record 成功后消费 pending；失败（抛错）自然保留，下次再试
	const mid = snapshotLibrary(cwd);
	const recordChanges = diffLibrary(before, mid);
	const gated = gatedLibrary(cwd);
	const targets = autoVerifyTargets(gated, recordChanges);
	const results = await runBounded(targets, config.autoVerifyConcurrency, (one) =>
		runWorker({ ...base, kind: "verify", rowId: `verify ${one.id}`, task: verifyTask([one]) }));
	const failures = results
		.filter((r): r is PromiseRejectedResult => r.status === "rejected")
		.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
	const model = config.autoModel ? config.autoModel.id : "main model";
	const lines = [`record: ${formatChanges("record", recordChanges)}`, `verify: ${formatChanges("verify", diffLibrary(mid, snapshotLibrary(cwd)))}`];
	if (failures.length > 0) lines.push(`${failures.length} failed: ${failures.join("; ")}`);
	lines.push(...backlogLines(leftoverStock(gated, targets)));
	say(`Memory Auto (${model})`, lines);
}

/** 存量积压 = 全库待办减去本轮已验对象（auto 只清增量，存量提醒手动清账） */
export function leftoverStock(gated: GatedEntity[], verified: PendingEntity[]): PendingEntity[] {
	const done = new Set(verified.map((p) => p.id));
	return toPending(selectPending(gated)).filter((p) => !done.has(p.id));
}

/** 存量积压提醒行（无积压返回空）；id 清单超长时折叠 */
export function backlogLines(leftover: PendingEntity[]): string[] {
	if (!leftover.length) return [];
	const ids = leftover.map((p) => p.id);
	const shown = ids.length > ID_PREVIEW_MAX ? ids.slice(0, ID_PREVIEW_MAX).concat(`… +${ids.length - ID_PREVIEW_MAX}`) : ids;
	return [`backlog ${ids.length}: ${shown.join(", ")} — run /memory verify all to clear.`];
}

/** 汇总通知里积压 id 的预览上限 */
const ID_PREVIEW_MAX = 8;

/** auto verify 清单：本轮 record 新增/更新的实体（增量语义）；存量积压走手动 /memory verify all */
export function autoVerifyTargets(gated: GatedEntity[], changes: LibraryChanges): PendingEntity[] {
	const touched = new Set([...changes.addedEntities, ...changes.updatedEntities]);
	return toPending(gated.filter((g) => touched.has(g.meta.id)));
}

/**
 * 波次并发执行：同时最多 limit 个任务（每实体一个 verify worker），
 * 单个失败不中断整批，结果逐个收集（allSettled 语义）。
 */
export async function runBounded<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<PromiseSettledResult<void>[]> {
	const size = Math.max(1, limit);
	const results: PromiseSettledResult<void>[] = [];
	for (let i = 0; i < items.length; i += size) {
		results.push(...(await Promise.allSettled(items.slice(i, i + size).map((item) => task(item)))));
	}
	return results;
}
