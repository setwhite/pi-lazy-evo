/**
 * 验证 worker：不带素材，按 entities.md（读实体用）+ verifications.md（记录/验证器/门控）+ verify.md 核对。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../core/config.ts";
import type { Runtime } from "../index.ts";
import { promptHeader, runSingleWorker } from "./worker.ts";

/** 验证 worker 提示词：只做验证（verify），读实体面 + 验证面 */
export function buildVerifyWorkerPrompt(input: { protocolDir: string; cwd: string; maxTurns: number }): string {
	return [
		"你是 lazy-memory 的后台验证代理，任务是在 headless 环境里操作 .memory/ 记忆库。",
		`- 协议手册：先读 ${input.protocolDir}/entities.md（读实体用）与 ${input.protocolDir}/verifications.md（验证记录/验证器/门控），再按 ${input.protocolDir}/verify.md 执行。`,
		"- 任务：找出 .memory/ 里 unverified 或 stale 的实体（无验证记录、或正文自上次验证后被修改），逐条核对并按协议追加验证记录（evidence 必填，只追加不覆盖）。",
		"- 涉及时效性/外部可查事实时，可用联网检索做 web-research 验证（若工具可用）；本地可核对的用 format/conflict/local-evidence。",
		...promptHeader(input.cwd, input.maxTurns),
	].join("\n");
}

/** 跑验证 worker：拼提示词 → 执行 */
export async function runVerifyWorker(runtime: Runtime, ctx: ExtensionContext, config: MemorySettings): Promise<void> {
	const prompt = buildVerifyWorkerPrompt({ protocolDir: runtime.protocolDir, cwd: ctx.cwd, maxTurns: config.autoMaxTurns });
	await runSingleWorker("验证", ctx, config, config.autoVerifyTools, prompt);
}