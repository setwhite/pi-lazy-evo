/**
 * 注入提示词：命令扳机的"给模型的指令"。
 * 模型是执行者：读到提示词后自行阅读 PROTOCOL.md、用通用工具
 * （grep/read/write/bash）操作 .memory/——扩展不注入任何工具。
 * 自动模式（turn_end 时钟）将来复用同一份提示词，暂不实现。
 * 协议文档路径由调用方（Runtime）注入，提示词层不感知部署位置。
 */
import { GATE_LABEL } from "../../gate.ts";

/** 沉淀提示词集：record/query/verify 三条注入指令 */
export interface SettlerPrompts {
	/** 沉淀（增 + 改）：提醒模型自行读写 .memory/ */
	record(): string;
	/** 检索：带关键词（可空）的检索提醒 */
	query(terms: string): string;
	/** 验证：带待验清单的验证提醒 */
	verify(entities: { id: string; kind: string; state: string }[]): string;
}

/** 用协议文档路径构建提示词集（路径与提示词内容解耦） */
export function createPrompts(protocolPath: string): SettlerPrompts {
	return {
		record: () =>
			`[lazy-memory] A memory settlement is requested. Read ${protocolPath} first, then: ` +
			"extract the durable conclusions from the recent conversation; " +
			"search .memory/entities for related entities yourself (grep/read); " +
			"create new entities or update existing ones following the protocol (id/kind/sources/assertions format, sources appended with ；); " +
			"follow the git conventions in the protocol. " +
			"Do not record transient details; only durable conclusions worth citing later.",
		query: (terms) => {
			const termsLine = terms ? `Search terms: ${terms}` : "No search terms given — infer the search intent from the recent conversation.";
			return (
				`[lazy-memory] A memory retrieval is requested. Read ${protocolPath}, then search .memory/entities yourself (grep/read). ` +
				`${termsLine} For each hit report: entity id, kind, gate state (${GATE_LABEL.passed} / ${GATE_LABEL.failed} / ${GATE_LABEL.none} / ${GATE_LABEL.stale}, ` +
				"by comparing the latest verification against the file mtime), and relevant assertions. " +
				"Cite entity ids; if nothing relevant is found, state that there is no record."
			);
		},
		verify: (entities) => {
			const list = entities.map((e) => `- ${e.id} [${e.kind}] ${GATE_LABEL[e.state as keyof typeof GATE_LABEL]}`).join("\n");
			return (
				`[lazy-memory] Manual verification requested for these entities (gate states attached):\n${list}\n` +
				`Read ${protocolPath} first, then verify each entity yourself: check the front-matter format, conflicts against other entities, ` +
				"run command checks and web research as needed, or ask the user. " +
				"Append verification records following the protocol (validator + checked_at + result + evidence; evidence required). " +
				"Only append passed when you actually verified; otherwise append failed with the reason. " +
				"Report the gate states after verification."
			);
		},
	};
}