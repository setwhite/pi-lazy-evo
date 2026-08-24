# lazy-memory

一个"懒惰"的 AI 记忆库：**被动记录、grep 检索、验证门控**。

> 你没有存记忆的意识，就不会有记忆。

为 AI 编码代理（pi 等支持扩展的 CLI 工具）提供被动记忆：
人触发写入、grep 语义检索、验证驱动失效。扩展只做命令扳机与门控计算，
读写验证由代理按协议手册执行（零工具注入）。

```bash
/memory            # 总览：挡位 + 四态分布 + 待验清单
/memory record     # 沉淀：代理把近期结论写入 .memory/
/memory query      # 检索：代理 grep 记忆库（可带关键词）
/memory verify     # 验证：算出待验清单，代理逐条核对
/memory mode       # 挡位：manual / auto（auto 未实现）
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/README.md](docs/README.md) | 总览、快速上手、目录结构 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计：分层、数据模型、设计决策 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发指南：测试、编码约定、如何新增命令 |
| [docs/USER.md](docs/USER.md) | 用户指南：5 个 `/memory` 命令完整用法 |
| [extension/protocol/](extension/protocol/schema.md) | 协议手册（代理执行契约，英文） |

## 安装

待发布（见 docs/ARCHITECTURE.md 发布待办）。目标形态：软链
`~/.pi/extensions/lazy-memory` → 本仓库 `extension/`。

## License

[MIT](LICENSE)
