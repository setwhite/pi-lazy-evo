/**
 * 配置读取/写入：settings.json 的 lazy-memory 命名空间。
 * 全局（~/.pi/agent/settings.json）与项目（<cwd>/.pi/settings.json）合并，项目覆盖全局。
 * 模式切换只写 settings.json——模型可见面（工具集/描述/提示词）不变，不影响 prompt cache。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 扩展命名空间名 */
const NAMESPACE = "lazy-memory";

/** 运行模式：manual = 仅手动工具；auto = 后台提取（行为尚未实现，字段即状态） */
export type MemoryMode = "manual" | "auto";

/** 扩展配置 */
export interface MemorySettings {
	/** 运行模式 */
	mode: MemoryMode;
}

/** 默认配置：手动挡 */
const DEFAULTS: MemorySettings = { mode: "manual" };

/** 读取单个 settings.json 中的命名空间，失败返回 null */
function readNamespace(path: string): Partial<MemorySettings> | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const ns = raw[NAMESPACE];
		if (typeof ns !== "object" || ns === null) return null;
		return ns as Partial<MemorySettings>;
	} catch {
		return null;
	}
}

/** 合并全局与项目配置（项目覆盖全局） */
export function loadConfig(cwd: string): MemorySettings {
	const merged: MemorySettings = { ...DEFAULTS };
	const namespaces = [readNamespace(join(homedir(), ".pi", "agent", "settings.json")), readNamespace(join(cwd, ".pi", "settings.json"))];
	for (const ns of namespaces) {
		if (!ns) continue;
		if (ns.mode === "manual" || ns.mode === "auto") merged.mode = ns.mode;
	}
	return merged;
}

/** 写入模式到项目 settings.json（保留文件其余内容；目录缺失时静默跳过） */
export function setMode(cwd: string, mode: MemoryMode): boolean {
	const path = join(cwd, ".pi", "settings.json");
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		// 项目 .pi/settings.json 不存在时按空对象处理
	}
	data[NAMESPACE] = { ...(typeof data[NAMESPACE] === "object" && data[NAMESPACE] ? (data[NAMESPACE] as Record<string, unknown>) : {}), mode };
	try {
		writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
		return true;
	} catch {
		return false;
	}
}