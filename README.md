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

## 安装（作为 pi 包）

**Via npm（推荐）：**

```bash
pi install npm:pi-lazy-evo
```

**仅当前项目：**

```bash
pi install -l npm:pi-lazy-evo
```

**Via git：**

```bash
pi install git:github.com/setwhite/pi-lazy-evo
```

**固定版本：**

```bash
pi install git:github.com/setwhite/pi-lazy-evo@v0.1.0
```

**本地开发 / 手动安装：**

```bash
git clone https://github.com/setwhite/pi-lazy-evo.git
cd pi-lazy-evo
pi install ./    # 从目录安装
```

或临时测试（不写入设置）：

```bash
pi -e ./
```

重启 pi 自动加载。记忆库默认在项目工作目录 `.memory/`（`MEMORY_DIR` 可覆盖）。

## 文档

- [docs/USER.md](https://github.com/setwhite/pi-lazy-evo/blob/main/docs/USER.md) 用户指南：命令用法，扩展配置
- [docs/ARCHITECTURE.md](https://github.com/setwhite/pi-lazy-evo/blob/main/docs/ARCHITECTURE.md) 架构设计
- [docs/DEVELOPMENT.md](https://github.com/setwhite/pi-lazy-evo/blob/main/docs/DEVELOPMENT.md) 开发指南

文档随包分发，安装后也可在 `node_modules/pi-lazy-evo/docs/` 本地查看。

## License

[MIT](LICENSE)
