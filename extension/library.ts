/**
 * 库变化检测域：worker 前后的库快照 + 差异判定 + 通知文案。
 * 成败以文件系统快照 diff 判定（子进程事件流只用于活动展示，退出码仅兑底报错）。
 * 验证记录 key 用相对 verifications 根的路径：子目录化后 basename 会跨实体重复。
 */
import { relative } from "node:path";
import { listEntities, listVerifications, memoryDir } from "./store.ts";

/** worker 任务类型：record 只写实体，verify 只追加验证记录 */
export type WorkerKind = "record" | "verify";

/** 库快照：实体 id→mtime + 验证记录相对路径→(target,result)，供 worker 前后 diff */
export interface LibrarySnapshot {
	entityMtimes: Map<string, number>;
	verifications: Map<string, { target: string; result: "passed" | "failed" }>;
}

/** 变化摘要：实体新增/更新 + 新增验证记录 */
export interface LibraryChanges {
	addedEntities: string[];
	updatedEntities: string[];
	newVerifications: { id: string; result: "passed" | "failed" }[];
}

/** 快照当前库：实体 mtime + 验证记录文件（纯 IO，无副作用） */
export function snapshotLibrary(cwd: string): LibrarySnapshot {
	return {
		entityMtimes: new Map(listEntities(cwd).map((m) => [m.id, m.mtimeMs])),
		verifications: new Map(listVerifications(cwd).map((v) => [relative(memoryDir(cwd), v.path), { target: v.target, result: v.result }])),
	};
}

/** 前后快照对比：实体新增/更新 + 新增验证记录（实体删除不报） */
export function diffLibrary(before: LibrarySnapshot, after: LibrarySnapshot): LibraryChanges {
	const addedEntities = [...after.entityMtimes.keys()].filter((id) => !before.entityMtimes.has(id));
	const updatedEntities = [...after.entityMtimes.entries()]
		.filter(([id, mtime]) => {
			const prev = before.entityMtimes.get(id);
			return prev !== undefined && prev !== mtime;
		})
		.map(([id]) => id);
	const newVerifications = [...after.verifications.entries()]
		.filter(([file]) => !before.verifications.has(file))
		.map(([, v]) => ({ id: v.target.replace(/^entities\//, "").replace(/\.md$/, ""), result: v.result }));
	return { addedEntities, updatedEntities, newVerifications };
}

/** 通知文案策略表：kind → 格式化函数（无变化统一返回"no changes"） */
const FORMATTERS: Record<WorkerKind, (changes: LibraryChanges) => string> = {
	record: (c) => {
		const parts: string[] = [];
		if (c.addedEntities.length) parts.push(`+ ${c.addedEntities.join(", ")}`);
		if (c.updatedEntities.length) parts.push(`~ ${c.updatedEntities.join(", ")}`);
		return parts.length ? parts.join(" | ") : "no changes";
	},
	verify: (c) => {
		if (!c.newVerifications.length) return "no changes";
		const list = c.newVerifications.map((v) => `${v.id} ${v.result === "passed" ? "✅" : "⚠️"}`).join(", ");
		return `+ verified: ${list}`;
	},
};

/** 变化清单 → 一行通知文本 */
export function formatChanges(kind: WorkerKind, changes: LibraryChanges): string {
	return FORMATTERS[kind](changes);
}