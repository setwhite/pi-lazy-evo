/**
 * 配置读写：settings.json 的 pi-lazy-evo 命名空间。
 * mode 只存全局（~/.pi/agent/settings.json）——用户偏好，不入库不随仓库分发；
 * 其余字段全局与项目（<cwd>/.pi/settings.json）合并，项目覆盖全局。
 * 模式切换只写全局 settings.json——模型可见面（工具集/描述/提示词）不变，不影响 prompt cache。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 扩展命名空间名 */
const NAMESPACE = "pi-lazy-evo";

/** 运行模式：manual = 仅手动命令；auto = 命令 + 后台自动 record/verify */
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

/** record worker 默认工具白名单：读库/检索/写库够用，不放开联网 */
const DEFAULT_MEMO_TOOLS = ["read", "grep", "ls", "bash", "write", "edit"] as const;
/** 验证 worker 默认工具白名单：多 web 检索，支持 web 验证器 */
const DEFAULT_VERIFY_TOOLS = [...DEFAULT_MEMO_TOOLS, "web_search", "web_fetch"] as const;

/** 扩展配置 */
export interface MemorySettings {
	/** 运行模式 */
	mode: MemoryMode;
	/** 自动 record 触发阈值：会话新增消耗达该 token 数触发一次 */
	autoWatermarkTokens: number;
	/** 后台 worker 最大轮数（成本上限） */
	autoMaxTurns: number;
	/** 会话边界冲刷节流：距上次固化的增量低于此 token 数跳过（0 = 有素材即冲刷） */
	autoFlushMinTokens: number;
	/** 便宜模型（缺省用主会话模型） */
	autoModel?: AutoModel;
	/** record worker 工具白名单 */
	autoMemoTools: string[];
	/** 验证 worker 工具白名单 */
	autoVerifyTools: string[];
}

/** 默认配置：手动挡；触发器 32k token；worker 上限 16 轮；冲刷节流 8k */
const DEFAULTS: MemorySettings = {
	mode: "manual",
	autoWatermarkTokens: 32_000,
	autoMaxTurns: 16,
	autoFlushMinTokens: 8_000,
	autoMemoTools: [...DEFAULT_MEMO_TOOLS],
	autoVerifyTools: [...DEFAULT_VERIFY_TOOLS],
};

/** 解析正整数：非有限正整数返回 undefined（非法忽略） */
function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 解析非负整数：0 合法（语义为“有素材即冲刷”），负数/非整数返回 undefined */
function nonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
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

/** 全局 settings.json 路径：$PI_GLOBAL_SETTINGS_FILE 可覆盖（测试/多用户隔离），默认用户 home */
function globalSettingsFile(): string {
	return process.env.PI_GLOBAL_SETTINGS_FILE ?? join(homedir(), ".pi", "agent", "settings.json");
}

/** 命名空间字段解析器表：settings 键 → 解析函数（解析失败返回 undefined 即忽略该字段） */
const FIELD_PARSERS: Record<keyof MemorySettings, (value: unknown) => unknown> = {
	mode: (v) => (v === "manual" || v === "auto" ? v : undefined),
	autoWatermarkTokens: positiveInt,
	autoMaxTurns: positiveInt,
	autoFlushMinTokens: nonNegativeInt,
	autoModel: parseAutoModel,
	autoMemoTools: parseTools,
	autoVerifyTools: parseTools,
};

/** 解析单个 settings.json 中的命名空间为配置片段；读取失败或缺命名空间返回 null */
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
	const entries: [string, unknown][] = [];
	for (const [key, parse] of Object.entries(FIELD_PARSERS)) {
		const value = parse(data[key]);
		if (value !== undefined) entries.push([key, value]);
	}
	return Object.fromEntries(entries) as Partial<MemorySettings>;
}

/** 项目可覆盖字段：mode 除外——mode 是用户偏好，只存全局 settings */
const PROJECT_KEYS = (Object.keys(FIELD_PARSERS) as (keyof MemorySettings)[]).filter((key) => key !== "mode");

/** 合并全局与项目配置（mode 只从全局取；其余字段项目覆盖全局） */
export function loadConfig(cwd: string): MemorySettings {
	const merged: MemorySettings = { ...DEFAULTS };
	const sources: [string, (keyof MemorySettings)[]][] = [
		[globalSettingsFile(), Object.keys(FIELD_PARSERS) as (keyof MemorySettings)[]],
		[join(cwd, ".pi", "settings.json"), PROJECT_KEYS],
	];
	for (const [path, keys] of sources) {
		const ns = readNamespace(path);
		if (!ns) continue;
		for (const key of keys) {
			if (ns[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = ns[key];
		}
	}
	return merged;
}

/** 切换模式：写入全局 settings.json（目录缺失自动创建；保留文件其余内容） */
export function setMode(mode: MemoryMode): boolean {
	const path = globalSettingsFile();
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		// 文件不存在或损坏：按空对象处理
	}
	data[NAMESPACE] = { ...(typeof data[NAMESPACE] === "object" && data[NAMESPACE] ? (data[NAMESPACE] as Record<string, unknown>) : {}), mode };
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
		return true;
	} catch {
		return false;
	}
}