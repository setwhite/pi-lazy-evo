# pi-lazy-evo

一个"懒惰"的 AI 记忆库：**被动记录、grep 检索、验证门控，可选 auto 挡自动沉淀验证**。

> 你没有存记忆的意识，就不会有记忆。

为 pi 等支持扩展的编码代理提供被动记忆。扩展只做命令扳机与门控计算，
读写与验证由代理按协议手册执行（零工具注入）。

```bash
/memory            # 帮助
/memory overview   # 总览：挡位 + 四态分布 + 待验清单
/memory record     # 让代理把长期结论写入 .memory/（可带附注）
/memory query      # 让代理 grep 检索记忆库（可带关键词）
/memory verify     # 让代理核对待验实体（可带实体 id）
/memory mode       # 查看/切换 manual / auto 挡位
```

## 挡位

- `manual`（默认）：只有手动 `/memory` 命令触碰记忆库。
- `auto`：后台便宜模型按 token 水位自动沉淀 + 验证（turn_end 双 worker），配置在
  项目 `.pi/settings.json` 的 `pi-lazy-evo` 命名空间，详见 [docs/USER.md](docs/USER.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USER.md](docs/USER.md) | 用户指南：命令用法、auto 配置、门控状态 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计：分层、数据模型、设计决策 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发指南：测试、编码约定、新增子命令 |

代理执行契约在 [extension/protocol/](extension/protocol/)（中文手册目录，唯一真相源）：
`entities.md`（实体与库结构）、`verifications.md`（验证流水）、
`record.md` / `verify.md`（操作手册）。

## 安装

软链到 `~/.pi/agent/extensions/pi-lazy-evo`（全局）或项目 `.pi/extensions/pi-lazy-evo`（仅当前项目），
指向本仓库 `extension/`，pi 自动加载。
记忆库默认在当前工作目录 `.memory/`（`MEMORY_DIR` 环境变量可覆盖）。

## License

[MIT](LICENSE)