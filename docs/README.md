# lazy-memory — 总览

一个"懒惰"的 AI 记忆库：**被动记录、grep 检索、验证门控**。

> 你没有存记忆的意识，就不会有记忆。

面向 AI 编码代理（pi 等支持扩展的 CLI 工具）的被动记忆扩展。核心设计：
人触发写入、grep 语义检索、验证驱动失效。**扩展本身不读写、不检索、不验证**——
它只负责命令扳机与门控计算，真正的读写由代理按协议手册执行（零工具注入）。

## 特性

- **被动记录**：没有显式请求绝不写库，省 token、不越权。
- **grep 检索**：不建向量索引，用时 grep 全文 + 同义词补漏，库小翻得过来。
- **验证门控**：每条记忆都带"可信度标签"，未验证/已失效的不当事实用。
- **只追加、不覆盖**：验证记录是流水账，改错事实追加 failed 记录而非篡改正文，可审计。
- **协议即契约**：`protocol/` 手册是代理执行的唯一真相源，代码只是门童。

## 快速上手

依赖：pi（支持扩展的 CLI 编码代理）+ bun 运行时。

```bash
# 1. 把扩展装进 pi 的扩展目录（当前为待发布状态，详见 ARCHITECTURE 发布待办）
#    目标形态：软链 ~/.pi/extensions/lazy-memory → 本仓库 extension/ 目录
ln -s "$(pwd)/extension" ~/.pi/extensions/lazy-memory

# 2. 在 pi 会话里敲命令
/memory            # 总览：挡位 + 四态分布 + 待验清单
/memory record     # 让代理把近期结论沉淀进 .memory/
/memory query      # 让代理检索 .memory/（可带关键词）
/memory verify     # 算出待验清单，让代理逐条核对
/memory mode       # 查看/切换挡位（manual / auto）
```

用起来长这样：

```
/memory
→ Memory Overview
  Mode: manual
  Entities 3 | passed 1 / failed 0 / unverified 1 / stale 1
  Needs verification (2): foo (unverified), bar (stale)
  Run /memory verify for a batch check.
```

## 文档导航

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构设计：定位、分层、数据模型、设计决策 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 开发指南：测试、编码约定、如何新增命令 |
| [USER.md](USER.md) | 用户指南：5 个 `/memory` 命令完整用法 + auto 配置 |
| `extension/protocol/` | 代理执行的操作手册（英文，唯一真相源） |

## 目录结构

```
lazy-memory/
├── docs/                    # 人类文档（本目录）
├── extension/               # 扩展源码（pi 加载入口）
│   ├── index.ts             # 装配入口（保留根）
│   ├── core/                # 核心逻辑层：config / store / gate
│   ├── commands/            # 5 个 /memory 命令扳机
│   ├── agents/settler/      # 命令执行层：拼提示词 → dispatch
│   ├── tools/               # 通用工具：TUI 通知、front-matter 解析
│   ├── tests/               # bun:test 单元测试（按域拆分）
│   ├── protocol/            # 协议手册：entities/verifications 格式 + record/query/verify 手册
│   └── hooks/               # 自动挡：turn_end 水位触发双 worker（沉淀/验证）
└── .memory/                 # 运行时记忆库（不入库）
```

## License

[MIT](../LICENSE)
