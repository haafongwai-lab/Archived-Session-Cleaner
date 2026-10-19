/**
 * dsh-archived-session-cleaner — 宿主半（host half）。
 *
 * 归档会话清理器：扫描 → 筛选 → 勾选 → 预览 → 备份 → 删除 → 验证。
 * 安全模型见 RESEARCH.md；存储发现见 storage-discovery.js；删除管线见 pipeline.js。
 *
 * HTTP API（同源，前缀 /dsh-asc/api）：
 *   GET  /capabilities        能力与存储确认状态
 *   GET  /storage             存储发现报告
 *   POST /storage/refresh     重新发现
 *   GET  /sessions            归档会话富化列表（支持筛选参数）
 *   POST /preview             删除前预览
 *   POST /backup              导出备份
 *   GET  /backups             备份列表
 *   GET  /backup/<id>/download  备份 tar.gz 下载
 *   POST /delete              执行删除（含验证报告）
 *   GET|POST /settings        设置读写
 *
 * 依赖的公开服务：workspaceRegistry、sessionQuery、sessionPersistence、webServer、timer。
 * 全部惰性读取（Loader 并发挂载，apply 时 ctx.get 可能为 undefined），fail-open 降级。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverStorage } from './storage-discovery.js'
import { createBackup } from './backup.js'
import { enrichArchivedSessions, applyFilters, makeStatsEngine, makeLineageEngine } from './enrich.js'
import { executeDelete, previewDelete, readArchivedSet, unarchiveSession } from './pipeline.js'
import { registerRoutes } from './routes.js'

export const name = 'dsh-archived-session-cleaner'
export const inject = ['timer']

/**
 * Standard Schema config: no runtime dependency on a schema package, so a
 * local `link:` install cannot be shadowed by an offline test stub.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-archived-session-cleaner',
    validate(value) {
      if (value === undefined || value === null) value = {}
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'plugin config must be an object' }] }
      }
      return {
        value: {
          /** 会话日志根目录（JSONL provider 的 config.root）。空 = 自动探测。 */
          sessionRoot: typeof value.sessionRoot === 'string' ? value.sessionRoot : '',
          /** 删除前必须成功导出并校验备份。 */
          requireBackup: typeof value.requireBackup === 'boolean' ? value.requireBackup : true,
          /** 单批删除上限（1-200）。 */
          maxBatch: Number.isFinite(value.maxBatch)
            ? Math.min(Math.max(1, Math.trunc(value.maxBatch)), 200)
            : 50,
        },
      }
    },
  },
}

const PLUGIN_DIR_NAME = 'archived-session-cleaner'
/** Respect a relocated Harness home; ~/.dsh is only the fallback. */
const DSH_HOME = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const PLUGIN_DATA_DIR = () => join(DSH_HOME(), PLUGIN_DIR_NAME)
const SETTINGS_FILE = () => join(PLUGIN_DATA_DIR(), 'settings.json')
const BACKUPS_DIR = () => join(PLUGIN_DATA_DIR(), 'backups')

function warn(...a) {
  console.error('[dsh-archived-session-cleaner]', ...a)
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function loadSettings(defaults) {
  try {
    const raw = await readFile(SETTINGS_FILE(), 'utf8')
    const p = JSON.parse(raw)
    return {
      sessionRoot: typeof p.sessionRoot === 'string' ? p.sessionRoot : defaults.sessionRoot,
      requireBackup: typeof p.requireBackup === 'boolean' ? p.requireBackup : defaults.requireBackup,
      maxBatch: Number.isFinite(p.maxBatch) ? Math.min(Math.max(1, Math.trunc(p.maxBatch)), 200) : defaults.maxBatch,
    }
  } catch {
    return { ...defaults }
  }
}

async function saveSettings(settings) {
  try {
    await mkdir(PLUGIN_DATA_DIR(), { recursive: true })
    await writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8')
  } catch (e) {
    warn('settings persist failed', e)
  }
}

export function apply(ctx, config) {
  // ---- 惰性服务读取 ----
  const registryOf = () => ctx.get('workspaceRegistry')
  const queryOf = () => ctx.get('sessionQuery')
  const persistenceOf = () => ctx.get('sessionPersistence')
  const timerOf = () => ctx.get('timer')
  const statsFor = makeStatsEngine(queryOf, timerOf)
  const lineageFor = makeLineageEngine(queryOf, timerOf)

  const defaults = {
    sessionRoot: config && typeof config.sessionRoot === 'string' ? config.sessionRoot : '',
    // Config supplies the schema default; only an explicit false disables backup.
    requireBackup: !config || config.requireBackup !== false,
    maxBatch: config && Number.isFinite(config.maxBatch)
      ? Math.min(Math.max(1, Math.trunc(config.maxBatch)), 200)
      : 50,
  }
  let settings = { ...defaults }
  // A request that arrives during startup must see persisted settings, not defaults.
  const settingsReady = loadSettings(defaults)
    .then((loaded) => { settings = loaded })
    .catch(() => {})

  // ---- 能力探测 ----
  function detectCapabilities() {
    const reg = registryOf()
    const q = queryOf()
    const p = persistenceOf()
    return {
      workspaceRegistry: !!reg,
      unarchivePublic: !!(reg && typeof reg.unarchiveSession === 'function'),
      unarchiveFallback: !!(reg && typeof reg.enqueueOperation === 'function'
        && typeof reg.requireState === 'function' && typeof reg.setState === 'function'),
      archivedIdsProp: !!(reg && Array.isArray(reg.archivedSessionIds)),
      detachSession: !!(reg && typeof reg.list === 'function'
        && reg.list().some((ws) => typeof ws.detachSession === 'function')),
      sessionQuery: !!(q && typeof q.listSessions === 'function'),
      titleSnapshots: !!(q && typeof q.readTitleSnapshots === 'function'),
      surface: !!(q && typeof q.readSurface === 'function'),
      lineage: !!(q && typeof q.traceSession === 'function'),
      persistenceStat: !!(p && typeof p.stat === 'function'),
      persistenceList: !!(p && typeof p.list === 'function'),
    }
  }

  // ---- 权威会话 id（用于存储交叉验证：全部持久化会话，不限归档） ----
  async function collectKnownIds() {
    const ids = new Set()
    try {
      const q = queryOf()
      if (q && typeof q.listSessions === 'function') {
        for (const r of (await q.listSessions()) || []) {
          if (r && r.header && r.header.id != null) ids.add(String(r.header.id))
        }
      }
    } catch { /* degrade */ }
    try {
      const p = persistenceOf()
      if (p && typeof p.list === 'function') {
        for (const s of (await p.list()) || []) {
          if (s && s.header && s.header.id != null) ids.add(String(s.header.id))
        }
      }
    } catch { /* degrade */ }
    return [...ids]
  }

  // ---- 存储发现（缓存 + 单飞） ----
  let storageReport = null
  let storageInflight = null
  async function getStorage(force = false) {
    await settingsReady
    if (storageInflight) return storageInflight
    if (storageReport && !force) return storageReport
    storageInflight = (async () => {
      const knownIds = await collectKnownIds()
      const report = await discoverStorage({
        configuredRoot: settings.sessionRoot,
        env: process.env,
        cwd: process.cwd(),
        knownIds,
      })
      storageReport = report
      return report
    })()
    try {
      return await storageInflight
    } finally {
      storageInflight = null
    }
  }

  // ---- 归档列表 ----
  async function listArchived(filters = {}) {
    const archivedIds = await readArchivedSet(registryOf)
    const storage = await getStorage(false)
    const items = await enrichArchivedSessions(
      archivedIds,
      { getRegistry: registryOf, getQuery: queryOf, statsFor, lineageFor },
      storage.status === 'confirmed' ? storage.matched : [],
    )
    return { total: items.length, items: applyFilters(items, filters), storage: { status: storage.status, root: storage.root } }
  }

  // ---- 预览 / 备份 / 删除 ----
  async function preview(ids) {
    const storage = await getStorage(false)
    return previewDelete(ids, storage, { getRegistry: registryOf })
  }

  async function doCreateBackup(ids) {
    const storage = await getStorage(false)
    if (storage.status !== 'confirmed') return { ok: false, reason: 'storage-unconfirmed' }
    const archivedSet = new Set(await readArchivedSet(registryOf))
    const matchedById = new Map((storage.matched || []).map((m) => [String(m.sessionId), m]))
    const items = []
    for (const raw of ids || []) {
      const id = String(raw)
      if (!archivedSet.has(id)) continue
      const matched = matchedById.get(id)
      if (!matched) continue
      items.push({ sessionId: id, projectDir: matched.projectDir, name: matched.name, path: matched.path })
    }
    if (items.length === 0) return { ok: false, reason: 'nothing-selected' }
    const snapshot = { archivedSessionIds: await readArchivedSet(registryOf), workspaces: [] }
    try {
      for (const ws of registryOf()?.list?.() || []) {
        snapshot.workspaces.push({ id: ws.id, path: ws.path ?? null, title: ws.title ?? null, sessionIds: (ws.sessionIds || []).map(String) })
      }
    } catch { /* degrade */ }
    const backup = await createBackup({ backupsDir: BACKUPS_DIR(), sessionRoot: storage.root, items, registrySnapshot: snapshot })
    if (backup.ok) await refreshStorageQuietly()
    return backup
  }

  let deleteInflight = false
  async function runDelete({ ids, force = false }) {
    if (deleteInflight) return { aborted: 'delete-in-flight' }
    deleteInflight = true
    try {
      const storage = await getStorage(false)
      return await executeDelete({
        ids,
        storage,
        force,
        settings,
        services: {
          getRegistry: registryOf,
          getQuery: queryOf,
          getPersistence: persistenceOf,
          getTimer: timerOf,
          probeActivity: probeActivity,
        },
        createBackup: async (payload) => doCreateBackup(payload.items.map((i) => i.sessionId)),
      })
    } finally {
      deleteInflight = false
      await refreshStorageQuietly()
    }
  }

  async function refreshStorageQuietly() {
    storageReport = null
    await getStorage(true).catch(() => {})
  }

  /**
   * Remove archive-set entries whose session is already gone.
   *
   * A stale archive id makes the Harness sidebar / archive list show a ghost
   * row that cannot be opened or restored. Only prune when all three signals
   * agree: confirmed storage, no persisted/live record, and no matched disk
   * directory. Any unavailable authoritative source aborts the whole run.
   */
  async function pruneOrphanedArchived() {
    const storage = await getStorage(false)
    if (storage.status !== 'confirmed') {
      return { ok: false, reason: 'storage-unconfirmed', pruned: 0, failed: [] }
    }
    const archived = await readArchivedSet(registryOf)
    if (archived.length === 0) return { ok: true, pruned: 0, prunedIds: [], failed: [] }

    const known = new Set()
    let sources = 0
    const q = queryOf()
    if (q && typeof q.listSessions === 'function') {
      try {
        for (const record of (await q.listSessions()) || []) {
          if (record && record.header && record.header.id != null) known.add(String(record.header.id))
        }
        sources += 1
      } catch {
        return { ok: false, reason: 'session-query-failed', pruned: 0, failed: [] }
      }
    }
    const p = persistenceOf()
    if (p && typeof p.list === 'function') {
      try {
        for (const snapshot of (await p.list()) || []) {
          if (snapshot && snapshot.header && snapshot.header.id != null) known.add(String(snapshot.header.id))
        }
        sources += 1
      } catch {
        return { ok: false, reason: 'persistence-list-failed', pruned: 0, failed: [] }
      }
    }
    if (sources === 0) return { ok: false, reason: 'no-session-source', pruned: 0, failed: [] }

    const matched = new Set((storage.matched || []).map((entry) => String(entry.sessionId)))
    const candidates = archived.filter((id) => !known.has(id) && !matched.has(id))
    const prunedIds = []
    const failed = []
    for (const id of candidates) {
      const activity = await probeActivity(id)
      if (activity && activity.available && activity.running) {
        failed.push({ sessionId: id, error: 'session-active' })
        continue
      }
      const result = await unarchiveSession(registryOf, id)
      if (result.ok) prunedIds.push(id)
      else failed.push({ sessionId: id, error: result.error, message: result.message || null })
    }
    if (prunedIds.length > 0) await refreshStorageQuietly()
    return {
      ok: failed.length === 0,
      pruned: prunedIds.length,
      prunedIds,
      candidates: candidates.length,
      failed,
    }
  }

  // ---- 运行活动探测（best-effort，waterfall 事件） ----
  async function probeActivity(sessionId) {
    try {
      const dispatch = typeof ctx.waterfall === 'function'
        ? ctx.waterfall
        : (typeof ctx.chain === 'function' ? ctx.chain : null)
      if (!dispatch) return { available: false }
      const result = await dispatch.call(ctx, 'workspace/session-activity', { sessionId: String(sessionId) }, async () => [])
      const activities = Array.isArray(result) ? result : []
      return { available: true, running: activities.length > 0, activities }
    } catch (e) {
      return { available: false, error: String((e && e.message) || e) }
    }
  }

  // ---- 设置 ----
  const getSettings = async () => {
    await settingsReady
    return { ...settings }
  }
  async function setSettings(patch) {
    await settingsReady
    const next = {
      sessionRoot: typeof patch?.sessionRoot === 'string' ? patch.sessionRoot : settings.sessionRoot,
      requireBackup: typeof patch?.requireBackup === 'boolean' ? patch.requireBackup : settings.requireBackup,
      maxBatch: Number.isFinite(patch?.maxBatch) ? Math.min(Math.max(1, patch.maxBatch), 200) : settings.maxBatch,
    }
    settings = next
    await saveSettings(next)
    await refreshStorageQuietly()
    return { ...settings }
  }

  // ---- 能力报告 ----
  async function getCapabilities() {
    const caps = detectCapabilities()
    const storage = await getStorage(false)
    return {
      services: caps,
      canScan: caps.workspaceRegistry || caps.sessionQuery,
      canDelete: caps.workspaceRegistry && storage.status === 'confirmed',
      storage: { status: storage.status, root: storage.root, warnings: storage.warnings || [] },
    }
  }

  // ---- 挂载路由 ----
  ctx.inject(['webServer'], (sub) => {
    registerRoutes(sub, {
      getCapabilities,
      getStorage,
      refreshStorage: () => getStorage(true),
      listArchived,
      preview,
      createBackup: doCreateBackup,
      runDelete,
      getSettings,
      setSettings,
      getBackupsDir: BACKUPS_DIR,
    })
    // Kept on the Host entry itself so a profile with a cached routes module
    // still exposes the maintenance endpoint after a plugin reload.
    sub.webServer.register({
      kind: 'exact',
      path: '/dsh-asc/api/prune-orphans',
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method-not-allowed' })
        try {
          writeJson(res, 200, await pruneOrphanedArchived())
        } catch (e) {
          writeJson(res, 500, { ok: false, pruned: 0, error: String((e && e.message) || e) })
        }
        return undefined
      },
    })
    info('host routes mounted')
  })

  function info(...a) {
    console.log('[dsh-archived-session-cleaner]', ...a)
  }
  info('host ready')
}
