# lazy-memory

一个"懒惰"的 AI 记忆库：**被动记录、grep 检索、验证门控**。

> 你没有存记忆的意识，就不会有记忆。

为 pi 等支持扩展的编码代理提供被动记忆。扩展只做命令扳机与门控计算，
读写与验证由代理按协议手册执行（零工具注入）。

```bash
/memory            # 帮助
/memory overview   # 总览：挡位 + 四态分布 + 待验清单
/memory record     # 让代理把长期结论写入 .memory/（可带附注）
/memory query      # 让代理 grep 检索记忆库（可带关键词）
/memory verify     # 让代理核对待验实体
/memory mode       # manual / auto 挡位
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USER.md](docs/USER.md) | 用户指南：命令用法、auto 配置、门控状态 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计：分层、数据模型、设计决策 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发指南：测试、编码约定、新增子命令 |

代理执行契约在 [extension/protocol/](extension/protocol/entities.md)（中文手册，唯一真相源）。

## 安装

软链 `~/.pi/agent/extensions/lazy-memory` → 本仓库 `extension/`，pi 自动加载。

## License

[MIT](LICENSE)
