# lazy-memory 项目方案与架构

> 状态：**架构已落地，迁移进行中**。扩展代码已按本文分层解耦并提交（`extension/` 内），
> 剩余迁移步骤见 §4 待办。本文是架构的唯一描述，新增代码以本文分层为准。

## 1. 项目定位

**.memory 实体记忆库的治理协议 + pi 扩展**：

- 协议（PROTOCOL.md）：实体格式、验证记录、四态门控、检索规则——唯一真相源；
- 扩展（TypeScript）：命令扳机（/memory 族）、门控计算、挡位状态（auto 预留）；
- 哲学：零工具注入，扩展只做扳机/门控/协议，读写与验证全部由 agent 按协议执行。

## 2. 当前结构（已落地）

```
lazy-memory/                    ← 单一项目仓库（复用旧仓库升级，v1 历史保留）
├── README.md                   项目说明（对外英文）
├── LICENSE                     MIT（沿用）
├── extension/                  扩展源码（pi 加载入口）
│   ├── index.ts / config.ts / store.ts / gate.ts
│   ├── agents/settler/         (agent.ts + prompts.ts)
│   ├── commands/               (5 命令)
│   ├── tools/                  (notify.ts + frontmatter.ts 通用工具)
│   ├── tests/                  bun:test 单元测试（bun test，按域拆分）
│   ├── hooks/                  自动模式钩子占位（未实现，暂空）
│   ├── PROTOCOL.md             协议唯一真相源（v2，含 v1 继承说明）
│   └── PROJECT.md              本文（架构与迁移方案）
└── lazy-memory/                v1 skill（已废弃，仅留历史）
```

## 3. 分层约定

| 层 | 职责 | 说明 |
|---|---|---|
| index | 装配 + 共享状态 | 入口内联 Runtime（协议路径 + dispatch 注入），薄壳不分文件 |
| config | 配置 | settings.json 的 lazy-memory 命名空间读写（挡位） |
| store | 存储 IO | .memory/ 读写；readLibrary 一次 IO 整库配对 |
| gate | 纯计算 | 四态门控；gateLibrary 批量门控，不 IO |
| agents/settler | 执行层 | 动作 = 拼提示词 → dispatch；命令与未来自动模式共用 |
| commands | 扳机 + 展示 | 只算输入与 TUI 通知，不跑协议逻辑 |
| tools | 通用工具 | 无状态：TUI 通知 notify、front-matter 解析 |
| tests | 单元测试 | bun:test 按域拆分（store/gate/config/commands），bun test 一键跑 |
| hooks | 钩子（空） | 自动模式 turn_end 钩子设计后启用（hooks/ 占位） |

## 4. 迁移进度（对照 2026-08-23 方案）

已完成：

- [x] 建仓：extension/ 入库提交（chore + feat 两提交），README 更新为扩展版
- [x] 目录平移：扩展源码移入 extension/，PROTOCOL/PROJECT 随目录分发
- [x] 协议合并：PROTOCOL v2 唯一化，v1 继承规则已在文中
- [x] 回归验证：bun test 36 例全绿 + tsc 零错误（含批量门控一致性断言）

待办（需确认后执行）：

- [ ] v1 清理：删除 `AGI/.pi/skills/lazy-memory/` 等安装副本（v1 已被 v2 取代）
- [ ] 安装位软链：`AGI/.pi/extensions/lazy-memory` → `<仓库>/extension`（改动即时生效，发布即 push）
- [ ] 端到端回归：`pi -e` 验证命令可用、零工具确认
- [ ] 发布：push GitHub

## 5. 开发路线

1. 手动模式（已完成：零工具命令扳机）；
2. 自动模式（turn_end 时钟 + token 水位，设计未落盘，启用时补 `docs/auto-mode.md`）；
3. 发布 v2（README + LICENSE + 协议 + 扩展源码已就绪，待待办清空）。

## 6. 约束

- 协议路径（PROTOCOL.md）由 Runtime 注入（`index.ts` 默认与源码同目录），
  提示词层不感知部署位置；PROTOCOL 移仓库根时改 `index.ts` 一处即可。
- commit 遵循 Conventional Commits（协议内 `.memory/` 变更用 `memory:` scope）。