# dsh-archived-session-cleaner

**归档会话清理器 · Archived Session Cleaner for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（DSH）**

扫描、筛选、备份并**安全删除**已归档会话。第三方插件，与 DeepSeek 无隶属关系。独立第三方项目，MIT。

> v0.3.1 · 目标 DSH `>=0.1.0-rc.6 <0.3.0`，profile `web`
>
> v0.3.1 增加失效归档清理：会话目录已被删除、但仍留在 `archivedSessionIds`
> 里的幽灵记录会在插件加载时自动移出归档集合（只改归档标记，不删数据）；
> 页面也会提示并提供「清理失效记录」按钮。
>
> v0.3.0 将界面改为与 Harness 一致的「侧边栏面板图标 + `main` 页面」：
> 960px 内容列、20/28 标题、13/20 正文、28px 分段选项卡、32px 按钮、
> 34px 输入框、.5px 边框，以及 `--dsw-*` 主题 token / `elevation-*` 阴影。
>
> v0.2.0 修复了客户端半的加载方式：`lib/client.js` 以
> `window.__ModuleLoader__.load({ id, factory })` 注册，不再使用
> `export default`（旧写法会被 Web 客户端判定为
> “loaded without registering … via __ModuleLoader__.load”）。

## 为什么不是直接删文件

调研确认（详见 [RESEARCH.md](./RESEARCH.md)）：

- DSH 全库**没有任何删除会话的 API**。`SessionPersistence`（`create/open/stat/list/flush`）、`sessionQuery`（只读）、`Workspace.detachSession`（明言 "never touches the session's own stored log"）都不销毁数据；JSONL provider 的文档原话是 *"Nothing deletes session files — logs accumulate under root until removed externally"*——**外部清理是官方预期的唯一清除路径**。
- 会话日志按 `<root>/--<cwd>--/<encoded-id>/session.vN.jsonl[.zstd]` 存储，`root` 仅来自 provider 配置，无默认值、无环境变量。

因此删除 = 三层协调：`unarchiveSession`（移出归档集合）→ `detachSession`（摘除工作区账户）→ 文件级删除会话目录。本插件把「确认存储结构」做成硬闸门：**未确认前禁用一切删除**。

## 安全模型（七条不变量）

1. **存储确认**：候选根须通过结构验证（`--*--/<id>/session.*.jsonl*`）且与权威会话 id（`sessionQuery` / `sessionPersistence`）交叉验证，≥1 个精确匹配才 `confirmed`；否则 UI 显示未确认、删除禁用。
2. **只处理明确选中的归档会话**：目标 id 必须逐一满足「在归档集合内、非 live、无运行活动、已持久化、有已确认目录」。
3. **先备份后删除**（默认强制）：完整目录副本 + manifest（含注册表快照，可人工恢复）+ sha256 逐文件校验；校验失败整体中止，一个文件都不删。
4. **最小删除面**：只删「已确认的单个会话目录」精确路径；删除前瞬时复检（路径在 root 内、两层深度、段名与 id 对应、目录内为日志族）。严禁 glob / 通配。
5. **有序管线**：预检 → 备份 → 注册表 → 工作区 → 物理删除 → 验证。注册表在前：即使物理删除失败，会话只是恢复可见，数据仍在。
6. **删除后验证**：逐 id 四查（归档集合 / 工作区成员 / 持久化列举 / 磁盘目录），失败项逐条报告。
7. **失败隔离**：批量逐项执行，单项失败不整体回滚，报告分 `deleted / failed / skipped`。

## 功能

| 功能 | 说明 |
| --- | --- |
| 扫描归档会话 | 列表显示标题、会话 ID、创建/最后活动时间、消息数、磁盘占用、工作区、子代理/空会话/有后代标记 |
| 筛选 | 默认显示全部归档会话；可按标题关键词、仅空会话、仅子代理筛选 |
| 批量勾选 | 全选 / 反选 / 单选；底部实时显示已选数量与合计体积 |
| 单批保护 | 选择超过「单批上限」时禁用删除并提示；Host 端仍以 `batch-too-large` 兜底，报告中给出请求数 / 上限 |
| 失效归档清理 | 会话目录被删除后遗留的归档标记会在插件加载时自动清理；设置页也可手动「清理失效记录」 |
| 删除前预览 | 数量、逐项标识与大小、警告汇总（未归档 / 无目录 / 运行中 / 有后代） |
| 二次确认 | 勾选确认 **并输入 `DELETE`**；`requireBackup` 默认开启——自动创建并校验备份后才执行删除 |
| 备份导出 | 单独「导出备份」按钮生成 `.tar.gz`（含 manifest）；「备份」页可列出并下载历史备份 |
| 删除后验证 | 报告逐项结果：已删除并验证 / 失败（含阶段与原因）/ 跳过（含原因） |
| 设置 | 显式 `sessionRoot`、强制备份开关、单批上限；保存后自动重新发现存储 |

说明：DSH 的归档集合只存 id、**不记录归档时间**，列表展示的是创建时间与最后活动时间。

## 安装

```bash
# npm（发布后）
dsh plugin --profile web add dsh-archived-session-cleaner

# 或本地打包
npm run build && npm pack
dsh plugin --profile web add dsh-archived-session-cleaner-0.1.0.tgz

# 本地开发（不安装，--patch 直接加载）
pnpm dsh web --patch /absolute/path/to/Archived\ Session\ Cleaner/examples/cordis.patch.local.yml
```

安装后侧边栏出现归档清理器图标；点击进入完整页面。页面沿用 Harness 的
Plugins/Settings 页面规范：页头、分段选项卡、列表行、表单字段与对话框。

**看不到侧边栏图标 / 控制台报 `loaded without registering`？** 这说明安装的
`lib/client.js` 不是 Module Loader 格式。运行 `npm run build` 重新生成
`lib/client.js`，再重新安装本包并刷新页面。构建脚本会拒绝任何含
`import` / `export` 的客户端源码。

## 配置

`cordis.patch.yml`（安装期默认）或页面「设置」选项卡（运行时优先，持久化到 `$DSH_HOME/archived-session-cleaner/settings.json`；未设置 `DSH_HOME` 时为 `~/.dsh/archived-session-cleaner/settings.json`）：

```yaml
config:
  sessionRoot: ''      # JSONL provider 的 config.root 绝对路径；空 = 自动探测
  requireBackup: true  # 删除前必须成功导出并校验备份
  maxBatch: 50         # 单批删除上限（1-200）
```

**首次使用若显示「存储未确认」**：在设置页填入会话日志根目录（即 `@deepseek-ai/dsh-session-persistence-jsonl` 配置里的 `root`，可用 `dsh --profile web --dump-config` 查看），保存后自动重新发现。

## HTTP API（同源，前缀 `/dsh-asc/api`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/capabilities` | 服务能力 + 存储确认状态 |
| GET | `/storage` | 存储发现报告 |
| POST | `/storage/refresh` | 重新发现 |
| GET | `/sessions` | 归档会话富化列表（支持 keyword/empty/subagent/from/to/timeField/minSizeBytes 参数） |
| POST | `/preview` | 删除前预览 `{ ids }` |
| POST | `/backup` | 导出备份 `{ ids }` |
| GET | `/backups` | 备份列表 |
| GET | `/backup/<id>/download` | 备份 `.tar.gz` 下载 |
| POST | `/delete` | 执行删除 `{ ids, force? }` |
| POST | `/prune-orphans` | 清理已删除但仍保留归档标记的会话（只移出归档集合，不触碰数据） |
| GET/POST | `/settings` | 设置读写 |

## 架构

```
src/index.js            宿主插件：装配、设置、能力探测、存储发现缓存、删除编排
src/storage-discovery.js 安全核心：候选根发现、结构验证、id 交叉验证、删除前复检
src/pipeline.js          删除管线：预检 → 备份 → 注册表 → 工作区 → 物理删除 → 验证
src/backup.js            备份导出、sha256 校验、tar.gz 打包（无第三方依赖）
src/enrich.js            会话富化（标题/统计/血脉/工作区）与筛选
src/routes.js            HTTP 路由
src/client.js            浏览器半：Module Loader 工厂 + 侧边栏图标 + React 页面
lib/client.js            构建产物（scripts/build-lib.mjs 生成并做语法检查）
test/                    离线测试：mock DSH 服务 + 真实磁盘布局，19 个用例
```

依赖的公开服务：`workspaceRegistry`、`sessionQuery`、`sessionPersistence`、`webServer`、`timer`。全部惰性读取（Loader 并发挂载，apply 时 `ctx.get` 可能为 undefined），能力缺失时降级为只读，**从不阻塞原生行为**。

删除路径双表面兼容：优先公开 `unarchiveSession`，回退 `enqueueOperation → requireState → setState` 状态链（rc.6 验证过的契约）。

## 测试

```bash
node test/run-tests.mjs   # 21/21 通过
```

覆盖：存储发现与确认（含「有结构无 id 匹配」拒绝）、列表与筛选、预览、备份与 tar.gz 下载、sha256 校验、删除 happy path 与四查验证、幂等、安全护栏（未确认 / 非归档 / live / 运行活动 / 无目录 / 目录内含子目录 / 批量上限 / 备份失败整体中止）、**备份下载路径穿越拒绝**、**归一匹配不授权删除**、**失效归档标记清理（含存储未确认时拒绝）**、**Config Standard Schema 默认值与上限**、设置驱动的存储修复路径、纯函数单测、**客户端 Module Loader 注册、`sidebar.panellist` / `main` 槽注册与各渲染分支**。

## 已知限制

- 只处理 `web` profile；headless 无 UI（宿主 API 仍可用）。
- 物理删除依赖 JSONL provider 目录布局；布局变更时交叉验证失败 → 自动拒绝删除（安全侧失效，不是误删）。
- 不做归档内容全文搜索。
- DSH 处于 developer preview，API 有破坏性变更风险；`engines.dsh` 已声明兼容范围。

## 致谢

实现参考了生态插件 [dsh-unarchive](https://github.com/uwu9039/dsh-unarchive)（归档会话回收站）对 `workspaceRegistry` / `sessionQuery` / `webServer` 公开契约的用法。
