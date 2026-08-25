# pi-lazy-evo - 会自我进化的长期记忆

pi agent的扩展，把会话里的信息沉淀为**可验证的实体**，用**验证门控**决定是否采用。

让记忆越用越准，而不是越攒越脏。

## 为什么懒

不走数据库，本地md存储，人可读可修改。

不做RAG，不做索引维护，不做向量相似度，不做知识图谱，用grep进行语义检索。

## 解决什么问题

- 只写入不验证：幻觉写进记忆，越用效果越差。
- 只增加不修改：旧记忆与新事实冲突，干扰模型判断。
- 维护成本高：RAG、知识图谱、向量相似度。

## 快速开始（暂定）

把本仓库 `extension/` 软链到扩展目录

```bash
# 全局：所有项目生效
ln -s "$PWD/extension" ~/.pi/agent/extensions/pi-lazy-evo

# 仅当前项目
mkdir -p .pi/extensions
ln -s "$PWD/extension" .pi/extensions/pi-lazy-evo
```

重启 pi 自动加载。

记忆库默认在项目工作目录 `.memory/`（`MEMORY_DIR` 可覆盖）。

## 文档

- [docs/USER.md](docs/USER.md) 用户指南：命令用法，扩展配置
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 架构设计
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 开发指南

## License

[MIT](LICENSE)
