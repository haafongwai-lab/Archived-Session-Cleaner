# Archived Session Cleaner — 调研结论与安全模型

> 本文档记录插件开发前对 DeepSeek Harness（DSH）存储机制的调研结论，以及「如何安全删除归档会话」的推导过程。所有结论均来自 2026-10 对 DSH 官方仓库（`deepseek-ai/deepseek-harness`，developer preview）文档与生态插件源码的核验。

## 1. 术语与事实基线

| 事实 | 结论 | 来源 |
| --- | --- | --- |
| 归档语义 | 归档 ≠ 删除：只把会话 id 放入**注册表级持久集合**（archive set），会话日志、工作区成员关系全部保留；归档后从所有列表消失 | 官方 `docs/subsystems/workspace.md` |
| 归档集合 | `archiveSession(id)` 写入（同时移除 pin，互斥）；`unarchiveSession(id)` 移除（幂等、无存在性检查、未归档则免写） | 同上 |
| 归档副作用 | `agent/pre-step` 门读取持久归档集合，**阻止已归档会话继续跑模型步** | 同上 |
| 恢复现状 | 官方无恢复 UI，需 `unarchiveSession`（生态插件 dsh-unarchive 已实现） | 同上 + 生态插件 |
| 会话删除 | **全库不存在任何删除会话的 API**。`SessionPersistence`（`create/open/stat/list/flush`）、`sessionQuery`（只读）、`Workspace.detachSession`（只摘除账户、明言 "never touches the session's own stored log"）均不销毁数据 | `docs/subsystems/persistence.md`、`session.md`、`workspace.md` |
| JSONL provider 明确声明 | "**Nothing deletes session files** — logs accumulate under root until removed externally; the seam has no deletion API." 即外部清理是官方预期的唯一清除路径 | `packages/session/session-persistence-jsonl/README.md` |

**结论：删除归档会话 = 三层协调操作，且物理层必须由插件自行完成（这是官方留出的口子）：**

1. 注册表层：`unarchiveSession(id)` — 把 id 从归档集合移除；
2. 工作区表层：`Workspace.detachSession(id)` — 从各所属工作区账户摘除（否则侧边栏出现幽灵条目）；
3. 物理表层：删除 `<root>/--<cwd>--/<encoded-id>/` 目录 — **没有任何 API，只能文件级操作**。

## 2. 会话物理存储结构（已确认）

`@deepseek-ai/dsh-session-persistence-jsonl`（官方唯一一方 provider）的磁盘布局：

```text
<root>/                              # 必填配置项，无默认值、无环境变量；绝对路径
  --<normalized-cwd>--/              # 规范化工作目录生成的可读项目目录；无 cwd 时为 _no-cwd/
    <encoded-id>/                    # 会话 id 注入式转义成的单个安全路径段（无目录遍历、无碰撞）
      session.jsonl[.zstd]           # v0
      session.v1.jsonl[.zstd]        # v1 …… 数值最高的规范世代为当前日志
      session.v3.jsonl[.zstd]        # 当前世代 vN，随版本演进
      session.lock                   # POSIX flock；Windows 为命名信号量（无文件占用）
```

要点：

- **世代不可变**：committed generation paths "never renamed, replaced, or deleted"；写打开只发布新的 version-named 后继文件，源文件不动。运行读取时选数值最高世代。
- **压缩模式**：默认 `compression: 'zstd'`（带校验和的 Zstandard 帧串联，不可直接按行阅读）；`compression: 'none'` 时为纯文本行。**一个 root 只属于一种编码，不能混用**。
- **`root` 只能来自配置**：`cordis.yml` 中 `@deepseek-ai/dsh-session-persistence-jsonl` 行的 `config.root`。无默认值、无 `DSH_HOME` 环境变量、与 `~/.dsh` 无必然关系。
- **锁文件语义**：存在活写入者时会话被 `flock`/信号量独占；崩溃持有者的锁随进程消亡释放。删除锁文件会丧失排他性（POSIX）——备份时必须原样复制而非排除，删除时锁文件随目录一并消失是可接受的（进程崩溃场景下锁本就失效）。

## 3. 已确认的公开 API 面（插件可依赖）

宿主侧服务（`ctx.get(...)` / `ctx.inject([...])`）：

| 服务 | 可用能力（与本插件相关） |
| --- | --- |
| `workspaceRegistry` | `archiveSession` / `unarchiveSession` / `pinSession` / `unpinSession`；`list()` → `Workspace[]`；`get` / `create` / `delete` / `insertBefore` / `resolveByPath` |
| `Workspace`（实体） | `sessionIds`（有序拥有权数组）、`detachSession(id)`（幂等、不触碰日志）、`attachSession`、`insertSessionBefore`、`setTitle`、`status()` |
| `sessionQuery`（只读） | `listSessions()` → `SessionRecord[]`（`header{id,origin,createdAt,cwd,parentSession,isSeeded}`、`live`、`persisted`、`formatStatus`）；`readTitleSnapshots(ids)`；`readSurface(id)` → 事件流；`readSession` / `listEvents` / `filterSessions` / `traceSession`（血脉：祖先/后代）/ `searchSessions` |
| `sessionPersistence` | `stat(id)` → `{header, formatStatus, revision, eventCount, sizeBytes}`；`list()` → 快照数组。**无 delete** |
| `webServer` | `register({kind:'exact'\|'prefix', path, handler})` |
| `timer` | `timeout(ms)` |
| 事件 | `workspace/session-activity`（waterfall：查询会话仍在运行什么）；`workspace/session-stop`；`domain/changed` |

客户端侧（浏览器插件，Module Loader 格式）：

- 脚本顶层必须调用 `window.__ModuleLoader__.load({ id, factory })`，`id` 等于包名；`factory(require)` 返回 `{ name, inject, apply }`。写成 ESM `export default` 会被 Web 客户端判定为 “loaded without registering … via __ModuleLoader__.load”。
- `factory` 从模块表 `require('react')`；UI 通过 `ctx.slots.inject('sidebar.panellist', ...)` 注册侧边栏图标，再通过 `ctx.slots.inject('main', ...)` 注册同 id 的 `main` 页面，不向 `document.body` 追加应用。
- `ctx.get('timer'|'locale'|'workspaces')`、`ctx.get('slots')`；`ctx.on/effect` 管理生命周期（`ctx.effect` 返回 disposer）。
- 主题与尺寸沿用 Harness 页面规范：`--dsw-alias-*` token、`bg-layer-*` 表面、`elevation-*` 阴影、960px 内容列、20/28 标题、13/20 正文、28px 分段选项卡、32px 按钮、34px 输入框、.5px 边框。
- 宿主通信走同源 HTTP：`fetch('/dsh-asc/api/...')`。

打包与安装：

- 组合包 manifest：`package.json` 声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`），`engines.dsh` 声明兼容版本；客户端经 `package.json` 的 `dsh.client`（`platform:'web'`）+ `exports["./client"]` 声明；
- 安装：`dsh plugin --profile web add <pkg>`（npm / tarball / `github:user/repo#sha`）；
- 本地开发：`pnpm dsh web --patch ./cordis.patch.yml`（绝对路径插入行）。

## 4. 核心安全原则（用户需求 → 设计约束）

> 「不能在尚未确认存储机制时，直接删除看起来像会话的文件。」

推导为以下硬约束，全部在代码中落实：

1. **存储确认（Storage Confirmation）**：删除前必须完成存储发现——候选根须通过**结构验证**（存在 `--*--/<encoded-id>/session.*.jsonl*` 树）且与**权威会话 ID 交叉验证**（`sessionQuery.listSessions()` / `sessionPersistence.list()` 返回的 id 能在磁盘上找到对应目录）。未确认 → UI 禁用删除并引导用户显式配置 `sessionRoot`。
2. **只删明确选中的归档会话**：目标 id 必须逐一满足：在归档集合内、`live === false`、无运行中活动（`workspace/session-activity`）、已持久化。任一不满足 → 跳过并报告，绝不外溢。
3. **先备份后删除**：默认 `requireBackup=true`；备份 = 完整会话目录副本 + manifest（id、header、归档集合快照、注册表状态、结构信息）+ sha256 校验；备份校验失败 → 整体中止，不删任何文件。
4. **最小删除面**：物理删除只针对「单个已确认的会话目录」的精确路径；删除前瞬时复检（路径在 root 内、段名与目标 id 对应、目录内为 session 日志族）；严禁 glob / 通配 / 递归删项目目录。
5. **有序管线**：预检 → 备份 → 注册表清理（`unarchiveSession`）→ 工作区摘除（`detachSession`）→ 物理删除 → 验证。注册表操作在前：即使物理删除失败，会话只是恢复可见，数据仍在（安全失败模式）。
6. **删除后验证**：逐 id 检查四件事——归档集合中不存在、所有工作区 `sessionIds` 中不存在、`sessionPersistence.stat(id)` 不存在（或 `listSessions` 不再返回）、磁盘目录已消失。失败项逐条报告，不谎报成功。
7. **失败隔离**：批量操作逐 id 执行，单项失败不整体回滚（与官方 `restore-all` 语义一致），最终报告 `deleted/failed/skipped` 三类。
8. **归档时间不可用**：DSH 的归档集合只存 id（无时间戳），domain 存储亦不带修改时间语义。UI 展示创建时间、最后活动时间与会话 ID，并明示「归档时间未记录」。

## 5. 兼容性策略（双表面特性检测）

DSH 处于 developer preview，API 有破坏性变更风险。宿主接线缆时对每个能力做 `typeof` 检测，和平降级：

| 能力 | 首选 | 回退 |
| --- | --- | --- |
| 移出归档集合 | `registry.unarchiveSession(id)` | `enqueueOperation → requireState → 过滤 archivedSessionIds → setState`（dsh-unarchive 在 rc.6 验证过的路径） |
| 读归档集合 | `registry.archivedSessionIds` | `requireState().archivedSessionIds` |
| 会话列表 | `sessionQuery.listSessions()` | `sessionPersistence.list()` |
| 运行活动检测 | `ctx.parallel/emit('workspace/session-activity')` 类调用 | 仅用 `record.live === false` 判定并在报告中标注未检测 |

任一依赖缺失 → 对应功能降级或禁用删除（fail-open 到「只读」），绝不阻塞 DSH 原生行为。

## 6. 已知限制（v1 范围声明）

- 只处理 Web UI profile（`web`）；headless 不挂载 UI，但宿主 API 仍可用。
- 物理删除无法通过任何公开 API 完成，属于文件级操作；已用「确认 + 备份 + 复检 + 验证」四道关卡控制风险，但理论上仍依赖 JSONL provider 目录布局不变（布局变更时交叉验证会失败 → 自动拒绝删除）。
- 单批上限默认 50（可配置），避免长任务阻塞 Web 服务。
- 不做归档内容全文搜索（超出 v1 范围）。
