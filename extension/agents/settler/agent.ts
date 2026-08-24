/**
 * Settler agent：沉淀执行层（对齐 om 的 agents/* 模式）。
 * 三个动作 = "算输入 → 拼提示词 → runtime.dispatch 注入"。
 * 命令是扳机，agent 是执行体；未来自动模式（turn_end 时钟）
 * 直接调同一组动作，命令与时钟共用此层。
 */
import type { Runtime } from "../../index.ts";
import type { PendingEntity } from "../../gate.ts";
import { createPrompts } from "./prompts.ts";

/** 沉淀动作集：record/query/verify，全部经 Runtime 注入 */
export interface SettlerActions {
	/** 沉淀（增 + 改）：注入提醒，模型自行读写 .memory/ */
	record(): void;
	/** 检索：注入带关键词（可空）的检索提醒 */
	query(terms: string): void;
	/** 验证：注入带待验清单的验证提醒 */
	verify(entities: PendingEntity[]): void;
}

/** 用给定的运行时构建沉淀动作（协议路径与注入通道都来自 runtime，命令 handler 零装配） */
export function createSettlerActions(runtime: Runtime): SettlerActions {
	const prompts = createPrompts(runtime.protocolDir);
	return {
		record: () => runtime.dispatch(prompts.record()),
		query: (terms) => runtime.dispatch(prompts.query(terms)),
		verify: (entities) => runtime.dispatch(prompts.verify(entities)),
	};
}