/**
 * 存储层入口（barrel）：域实现拆分至 layout / entities / verifications，
 * 此处保留全库配对逻辑 readLibrary，并对外透出全部 store 符号。
 * 对外 import 路径（./store.ts）保持稳定，子域拆分对调用方透明。
 */
import type { EntityMeta } from "./entities.ts";
import type { VerificationRecord } from "./verifications.ts";
import { listEntities } from "./entities.ts";
import { listVerifications } from "./verifications.ts";

export { memoryDir, ensureMemoryDir } from "./layout.ts";
export type { EntityMeta, EntityFile } from "./entities.ts";
export { validateId, validateKind, readEntity, writeEntity, listEntities } from "./entities.ts";
export type { VerificationRecord } from "./verifications.ts";
export { listVerifications, appendVerification } from "./verifications.ts";

/** 实体与其验证记录配对（readLibrary 的返回项） */
export interface EntityWithVerifications {
	meta: EntityMeta;
	verifications: VerificationRecord[];
}

/** 一次 IO 读完整个库：实体全量 + 全部验证记录（按 target 分组配对），供批量门控使用 */
export function readLibrary(cwd: string): EntityWithVerifications[] {
	const byTarget = new Map<string, VerificationRecord[]>();
	for (const v of listVerifications(cwd)) {
		const list = byTarget.get(v.target) ?? [];
		list.push(v);
		byTarget.set(v.target, list);
	}
	return listEntities(cwd).map((meta) => ({ meta, verifications: byTarget.get(`entities/${meta.id}.md`) ?? [] }));
}

/** 简易 front-matter 解析见 tools/frontmatter.ts（实体与验证记录共用） */
