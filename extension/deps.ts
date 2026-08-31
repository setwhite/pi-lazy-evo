/**
 * 依赖失效域：带 depends-on 覆盖的唯一读库入口（/memory 各子命令共用）。
 * 失效是纯推导——最新 passed 验证之后依赖文件被改过即 stale，无缓存、无落盘；
 * 真相源始终只有实体 + 验证记录（gate.ts）。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { applyDepStaleness, gateLibrary, type GatedEntity } from "./gate.ts";
import { readLibrary } from "./store.ts";

/** 依赖文件 mtime（相对 cwd 解析）；文件缺失（重构期路径变化）返回 null，不置 stale */
function depMtime(cwd: string, rel: string): number | null {
	try {
		return statSync(join(cwd, rel)).mtimeMs;
	} catch {
		return null;
	}
}

/** 读库 → 门控推导 → 依赖失效覆盖：唯一的库读取标准入口 */
export function gatedLibrary(cwd: string): GatedEntity[] {
	const gated = gateLibrary(readLibrary(cwd));
	applyDepStaleness(gated, (rel) => depMtime(cwd, rel));
	return gated;
}
