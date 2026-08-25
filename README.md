# pi-lazy-evo — 会自我进化的代理记忆

pi 编码代理的记忆扩展：把会话里的长期结论沉淀为**带验证状态的实体卡片**，用四态门控
决定信任度，让记忆越用越准，而不是越攒越脏。

不装向量库、不做 RAG、零索引维护——检索就是 grep，验证就是按协议手册核对，
扩展只做命令扳机与门控计算。

## 解决什么问题

代理记忆最常见的三种死法：

| 问题 | 后果 |
|---|---|
| 只写不验 | 幻觉结论写进记忆，永远被当事实引用 |
| 只增不改 | 旧结论与新事实打架，没人知道谁对 |
| 维护太贵 | 整理、建索引、搭 RAG 管道，全是前置成本 |

对策：每条记忆必须**可验证**，验证结果决定它**能不能当事实用**。

## 核心机制

```
沉淀 ──► 验证 ──► 演化
结论 → 实体卡片    四态门控筛选    幸存者当事实用，谬误被淘汰
```

- **沉淀**：长期结论 → `.memory/entities/`，一句一个可验证断言
- **验证**：核对流水账只追加、可审计；passed 存活，failed 淘汰重验
- **演化**：auto 挡在会话结束时自动沉淀 + 验证，无需人为维护

每张实体按「最新验证记录 vs 正文修改时间」得出四态（passed / failed / unverified /
stale），决定它能不能当事实用，详见 [docs/USER.md](docs/USER.md)。

## 快速开始

### 安装

要求 pi 编码代理。把本仓库 `extension/` 软链到扩展目录（任选其一）：

```bash
# 全局：所有项目生效
ln -s "$PWD/extension" ~/.pi/agent/extensions/pi-lazy-evo

# 仅当前项目
mkdir -p .pi/extensions
ln -s "$PWD/extension" .pi/extensions/pi-lazy-evo
```

重启 pi 自动加载。记忆库默认在项目工作目录 `.memory/`（`MEMORY_DIR` 可覆盖）。

### 第一次使用

```
/memory record          # 把近期长期结论写入记忆库
/memory overview        # 查看挡位与四态分布
/memory verify          # 批量核对 unverified / stale 的实体
/memory query <关键词>  # 检索记忆
```

沉淀出来的实体卡片长这样（`.memory/entities/<id>.md`）：

```markdown
---
id: entity_id-validation-policy
kind: decision
sources: session-2025-01-id-validation-simplification
---

实体 ID 校验只保留三条防呆约束：拒绝空/纯空白、拒绝换行与制表符、
拒绝 `/` 和 `\`（id 用作文件名，含路径分隔符会逃出 entities 目录）。
```

完整命令表、门控四态与 auto 挡位配置见 [docs/USER.md](docs/USER.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USER.md](docs/USER.md) | 用户指南：命令用法、auto 配置、门控状态 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计：分层、数据模型、设计决策 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发指南：测试、编码约定、新增子命令 |

代理执行契约在 [extension/protocol/](extension/protocol/)（中文手册，唯一真相源）。

## License

[MIT](LICENSE)
