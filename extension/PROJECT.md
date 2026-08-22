# lazy-memory 项目方案与目录迁移计划

> 状态：**方案评审中**。本文描述 lazy-memory 的完整项目形态（现状、目标结构、
> 迁移步骤、决策点），评审通过后按步骤执行。当前扩展目录为开发态，迁移后
> 将成为独立项目的一部分。

## 1. 项目定位

**.memory 实体记忆库的治理协议 + pi 扩展**：

- 协议（PROTOCOL.md）：实体格式、验证记录、四态门控、检索规则——唯一真相源；
- 扩展（TypeScript）：命令扳机（/memory 族）、门控计算、挡位状态（auto 预留）；
- 哲学：零工具注入，扩展只做扳机/门控/协议，读写与验证全部由 agent 按协议执行。

## 2. 现状盘点（2026-08-23）

| 项 | 位置 | 形态 | git | 状态 |
|---|---|---|---|---|
| v1 skill（已发布） | `~/Desktop/lazy-memory/` | SKILL.md + references/PROTOCOL(v1) + scripts/(status.sh verify.sh) | GitHub `setwhite/lazy-memory`，5 commits | 已发布，被 v2 取代 |
| v2 扩展（开发中） | `~/Desktop/AGI/.pi/extensions/lazy-memory/` | index/runtime/config/store/gate/agents/commands + PROTOCOL(v2)，零工具注入 | 本地仓库，3 commits | 当前主力 |
| v1 skill 副本（安装态） | `~/Desktop/AGI/.pi/skills/lazy-memory/` | skill 安装副本 | 无 | 随 AGENTS.md 暴露，与 v2 并存 |
| v1 skill 副本（全局） | `~/.pi/agent/skills/lazy-memory/` | skill 安装副本 | 无 | 同上 |

**问题**：同一协议存在 v1/v2 双份；skill 形态与扩展形态并存；开发与发布分裂。

## 3. 目标结构（迁移后）

```
lazy-memory/                    ← 单一项目仓库（位置见决策点 1）
├── README.md                   项目说明（对外英文）
├── LICENSE                     MIT（沿用）
├── PROTOCOL.md                 协议唯一真相源（v2，含 v1 继承说明）
├── extension/                  扩展源码（pi 加载入口）
│   ├── index.ts / runtime.ts / config.ts / store.ts / gate.ts
│   ├── agents/settler/         (agent.ts + prompts.ts)
│   ├── commands/               (5 命令)
│   └── smoke.ts
├── scripts/                    （v1 的 status.sh 等如有价值则移植，否则删除）
└── docs/
    └── auto-mode.md            自动模式设计（未来实现时启用）
```

**pi 加载方式**：pi 扩展只从 `~/.pi/extensions/` 与 `<项目>/.pi/extensions/` 自动发现。
迁移后仓库与安装位分离：

> 仓库 = 源（开发、发布）；安装位 = 软链（`AGI/.pi/extensions/lazy-memory` → 仓库 `extension/`）。
> 软链不占空间、改动即时生效，发布即 `git push`，无复制步骤。

## 4. 迁移步骤

1. **建仓**：确定目标仓库位置（决策点 1），`git remote add` 关联 GitHub；
2. **历史合并**：扩展当前 3 commits 并入目标仓库（决策点 2）；
3. **目录平移**：扩展源码移入 `extension/`，PROTOCOL.md 移入仓库根，AUTO 方案移入 `docs/`；
4. **v1 清理**：
   - 删除 `AGI/.pi/skills/lazy-memory/`（skill 形态废弃，避免 AGENTS.md 继续暴露 v1）；
   - 删除 `~/.pi/agent/skills/lazy-memory/`（全局副本）；
   - Desktop 旧仓库内的 skill/ 历史由 commit 保留，工作树不再保留；
5. **协议合并**：PROTOCOL.md 唯一化（v2 = 现扩展版，v1 兼容规则已在文中）；
6. **安装位软链**：`AGI/.pi/extensions/lazy-memory` → `<仓库>/extension`（决策点 3）；
7. **回归验证**：smoke + `pi -e` 端到端（零工具确认、命令可用）；
8. **发布**：提交 + push GitHub，README 更新为扩展版说明。

## 5. 决策点（评审时确认）

| # | 问题 | 选项 |
|---|---|---|
| 1 | 主仓放哪 | A. 迁移到 `~/Desktop/lazy-memory/`（复用已发布仓库，直接升级 v2）／ B. 新建独立目录（如 `~/lazy-memory/`）／ C. 留在 AGI 内 |
| 2 | v2 历史怎么进新仓 | A. 保留 3 commits（remote add + merge）／ B. 全新 init（历史归零，文档重写） |
| 3 | 安装位 | A. 软链（推荐）／ B. 复制脚本／ C. 发布 npm 包装到全局 |
| 4 | v1 skill 删除 | A. 全部删除（AGI + 全局）／ B. 仅 AGI 副本删，全局留档 |

## 6. 开发路线（迁移后）

1. 手动模式（已完成：零工具命令扳机）；
2. 自动模式（turn_end 时钟 + token 水位，见 docs/auto-mode.md，设计已备）；
3. 发布 v2（GitHub：README + LICENSE + 协议 + 扩展源码）。

## 7. 本次方案落盘的变更

- 新增本文（PROJECT.md）到扩展目录；
- 删除误写的 AUTO-MODE.md（自动模式方案移入本文 §6 与未来 docs/）；
- 其余文件不动，等评审确认后再执行迁移。