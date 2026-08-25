/**
 * auto 自动挡：turn_end 时钟 + token 水位判定，串行派发两个后台任务（沉淀→验证）。
 * 任务语义与手动命令同一套（agents/actions.ts），只是通道不同：
 * 手动走主会话（agents/main.ts dispatch），自动走子进程（agents/workers spawn）。
 * 验证清单与手动 /memory verify 同一筛选（gate.selectPending 算好注入，不靠模型自找）。
 * 防循环：水位增量触发；worker 在跑时吸收增量不重复触发；compaction 回落重设基线。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemorySettings } from "../core/config.ts";
import { gateLibrary, selectPending, toPending } from "../core/gate.ts";
import { readLibrary } from "../core/store.ts";
import type { Runtime } from "../index.ts";
import { extractTranscript, recordTask, verifyTask } from "../agents/actions.ts";
import { runWorkerTask } from "../agents/workers/worker.ts";

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

/** 串行派发：先沉淀（带会话素材），后验证（算好待验清单注入） */
async function runAutoWorker(runtime: Runtime, ctx: ExtensionContext, config: MemorySettings): Promise<void> {
	const settle = recordTask(extractTranscript(ctx.sessionManager.getEntries()));
	await runWorkerTask("沉淀", settle, runtime.protocolDir, ctx, config, config.autoMemoTools);
	const pending = selectPending(gateLibrary(readLibrary(ctx.cwd)));
	const verify = verifyTask(toPending(pending));
	await runWorkerTask("验证", verify, runtime.protocolDir, ctx, config, config.autoVerifyTools);
}