/**
 * 配置读取/写入：settings.json 的 lazy-memory 命名空间。
 * 全局（~/.pi/agent/settings.json）与项目（<cwd>/.pi/settings.json）合并，项目覆盖全局。
 * 模式切换只写 settings.json——模型可见面（工具集/描述/提示词）不变，不影响 prompt cache。
 * auto 相关配置（阈值/模型）手动编辑 settings.json（参考 pi-observational-memory 的配置形态）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 扩展命名空间名 */
const NAMESPACE = "lazy-memory";

/** 运行模式：manual = 仅手动工具；auto = 后台便宜模型自动沉淀+验证 */
export type MemoryMode = "manual" | "auto";

/** auto 用的便宜模型：后台 worker 子进程指向的 model（缺省用主会话模型） */
export interface AutoModel {
	/** provider 名 */
	provider: string;
	/** model id */
	id: string;
	/** 可选 thinking 档位（off/low/medium…） */
	thinking?: string;
}

/** 沉淀 worker 默认工具白名单：读库/检索/写库够用，不放开联网 */
const DEFAULT_MEMO_TOOLS = ["read", "grep", "ls", "bash", "write", "edit"] as const;
/** 验证 worker 默认工具白名单：多 web 检索，支持 web-research 验证器 */
const DEFAULT_VERIFY_TOOLS = [...DEFAULT_MEMO_TOOLS, "web_search", "web_fetch"] as const;

/** 扩展配置 */
export interface MemorySettings {
	/** 运行模式 */
	mode: MemoryMode;
	/** 自动沉淀触发阈值：会话新增消耗达该 token 数触发一次 */
	autoWatermarkTokens: number;
	/** 后台 worker 最大轮数（成本上限） */
	autoMaxTurns: number;
	/** 便宜模型（缺省用主会话模型） */
	autoModel?: AutoModel;
	/** 沉淀 worker 工具白名单 */
	autoMemoTools: string[];
	/** 验证 worker 工具白名单 */
	autoVerifyTools: string[];
}

/** 默认配置：手动挡；触发器 64k token；worker 上限 12 轮 */
const DEFAULTS: MemorySettings = {
	mode: "manual",
	autoWatermarkTokens: 64_000,
	autoMaxTurns: 12,
	autoMemoTools: [...DEFAULT_MEMO_TOOLS],
	autoVerifyTools: [...DEFAULT_VERIFY_TOOLS],
};

/** 解析正整数：非有限正整数返回 undefined（非法忽略） */
function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 解析 autoModel：provider+id 非空才接受，thinking 可选 */
function parseAutoModel(value: unknown): AutoModel | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const m = value as Record<string, unknown>;
	const provider = typeof m.provider === "string" && m.provider.length > 0 ? m.provider : undefined;
	const id = typeof m.id === "string" && m.id.length > 0 ? m.id : undefined;
	if (!provider || !id) return undefined;
	const model: AutoModel = { provider, id };
	if (typeof m.thinking === "string" && m.thinking.length > 0) model.thinking = m.thinking;
	return model;
}

/** 解析工具白名单：非空字符串数组（去重）；非法或空返回 undefined（用默认） */
function parseTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const tools = value.filter((t): t is string => typeof t === "string" && t.length > 0);
	return tools.length === 0 ? undefined : [...new Set(tools)];
}

/** 解析单个 settings.json 中的命名空间为配置片段；失败或缺命名空间返回 null */
function readNamespace(path: string): Partial<MemorySettings> | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
	const ns = (raw as Record<string, unknown>)[NAMESPACE];
	if (typeof ns !== "object" || ns === null) return null;
	const data = ns as Record<string, unknown>;
	const partial: Partial<MemorySettings> = {};
	const mode = data.mode;
	if (mode === "manual" || mode === "auto") partial.mode = mode;
	const watermark = positiveInt(data.autoWatermarkTokens);
	if (watermark !== undefined) partial.autoWatermarkTokens = watermark;
	const turns = positiveInt(data.autoMaxTurns);
	if (turns !== undefined) partial.autoMaxTurns = turns;
	const model = parseAutoModel(data.autoModel);
	if (model) partial.autoModel = model;
	const memoTools = parseTools(data.autoMemoTools);
	if (memoTools) partial.autoMemoTools = memoTools;
	const verifyTools = parseTools(data.autoVerifyTools);
	if (verifyTools) partial.autoVerifyTools = verifyTools;
	return partial;
}

/** 合并全局与项目配置（项目覆盖全局） */
export function loadConfig(cwd: string): MemorySettings {
	const merged: MemorySettings = { ...DEFAULTS };
	const namespaces = [readNamespace(join(homedir(), ".pi", "agent", "settings.json")), readNamespace(join(cwd, ".pi", "settings.json"))];
	for (const ns of namespaces) {
		if (!ns) continue;
		if (ns.mode) merged.mode = ns.mode;
		if (ns.autoWatermarkTokens !== undefined) merged.autoWatermarkTokens = ns.autoWatermarkTokens;
		if (ns.autoMaxTurns !== undefined) merged.autoMaxTurns = ns.autoMaxTurns;
		if (ns.autoModel) merged.autoModel = ns.autoModel;
		if (ns.autoMemoTools) merged.autoMemoTools = ns.autoMemoTools;
		if (ns.autoVerifyTools) merged.autoVerifyTools = ns.autoVerifyTools;
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
