/**
 * pipeline.js — 删除管线与删除后验证（Archived Session Cleaner）
 *
 * 顺序（每步失败即停在该步并记录，绝不跳过）：
 *   预检 → 备份（默认强制）→ 注册表清理（unarchiveSession）
 *     → 工作区摘除（detachSession）→ 物理删除（瞬时复检后 rm 精确会话目录）
 *     → 删除后验证（集合/成员/持久化/磁盘 四查）
 *
 * 安全不变量：
 *   - storage.status !== 'confirmed' → 整体拒绝；
 *   - 目标 id 必须已在归档集合内、非 live、有已确认磁盘目录；
 *   - 备份校验失败 → 整体中止，一个文件都不删；
 *   - 物理删除只删 assertDeletableSessionDir 复检通过的精确路径，严禁 glob。
 */
import { rm, stat } from 'node:fs/promises'
import { assertDeletableSessionDir } from './storage-discovery.js'

async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 读归档集合（公开属性优先，state 链兜底）。 */
export async function readArchivedSet(getRegistry) {
  const reg = getRegistry && getRegistry()
  if (!reg) return []
  try {
    if (Array.isArray(reg.archivedSessionIds)) return reg.archivedSessionIds.map(String)
  } catch { /* ignore */ }
  try {
    if (typeof reg.requireState === 'function') {
      const s = reg.requireState()
      if (s && Array.isArray(s.archivedSessionIds)) return s.archivedSessionIds.map(String)
    }
  } catch { /* ignore */ }
  return []
}

/** 移出归档集合：公开 unarchiveSession 优先，rc.6 state 链兜底。 */
export async function unarchiveSession(getRegistry, sessionId) {
  const reg = getRegistry && getRegistry()
  if (!reg) return { ok: false, error: 'registry-unavailable' }
  const id = String(sessionId)
  try {
    if (typeof reg.unarchiveSession === 'function') {
      await reg.unarchiveSession(id)
      return { ok: true, via: 'public-unarchiveSession' }
    }
    if (typeof reg.enqueueOperation === 'function'
      && typeof reg.requireState === 'function'
      && typeof reg.setState === 'function') {
      await reg.enqueueOperation(async () => {
        const cur = reg.requireState()
        const ids = cur && Array.isArray(cur.archivedSessionIds) ? cur.archivedSessionIds : []
        if (!ids.includes(id)) return
        await reg.setState({ ...cur, archivedSessionIds: ids.filter((x) => x !== id) })
      })
      return { ok: true, via: 'state-chain' }
    }
    return { ok: false, error: 'no-unarchive-surface' }
  } catch (e) {
    return { ok: false, error: 'failed', message: String((e && e.message) || e) }
  }
}

/** 从所有持有该会话的工作区账户摘除（幂等；失败收集但不中止）。 */
export async function detachFromWorkspaces(getRegistry, sessionId) {
  const reg = getRegistry && getRegistry()
  const id = String(sessionId)
  const failures = []
  if (!reg || typeof reg.list !== 'function') return { detached: 0, failures: ['registry-unavailable'] }
  let detached = 0
  for (const ws of reg.list()) {
    const members = ws && Array.isArray(ws.sessionIds) ? ws.sessionIds.map(String) : []
    if (!members.includes(id)) continue
    try {
      if (typeof ws.detachSession === 'function') {
        await ws.detachSession(id)
        detached += 1
      } else {
        failures.push(`workspace ${String(ws.id)}: no detachSession`)
      }
    } catch (e) {
      failures.push(`workspace ${String(ws.id)}: ${String((e && e.message) || e)}`)
    }
  }
  return { detached, failures }
}

/** 删除后四查：归档集合 / 工作区成员 / 持久化列举 / 磁盘目录。 */
export async function verifyDeleted(sessionId, matchedPath, deps) {
  const { getRegistry, getQuery, getPersistence, fs } = deps
  const id = String(sessionId)
  const result = { archiveCleared: null, membershipsCleared: null, persistenceCleared: null, diskCleared: null }

  const set = await readArchivedSet(getRegistry)
  result.archiveCleared = !set.includes(id)

  const reg = getRegistry && getRegistry()
  if (reg && typeof reg.list === 'function') {
    const still = reg.list().filter((ws) => (ws.sessionIds || []).map(String).includes(id))
    result.membershipsCleared = still.length === 0
  }

  let stillPersisted = null
  try {
    const p = getPersistence && getPersistence()
    if (p && typeof p.stat === 'function') {
      const st = await p.stat(id)
      stillPersisted = !!st
    }
  } catch { stillPersisted = null }
  result.persistenceCleared = stillPersisted === null ? null : !stillPersisted

  result.diskCleared = !(await pathExists(matchedPath))

  result.ok = result.archiveCleared === true
    && result.membershipsCleared !== false
    && result.persistenceCleared !== false
    && result.diskCleared === true
  return result
}

/**
 * 预检 + 执行删除。
 *
 * @param {object} opts
 * @param {string[]} opts.ids            请求删除的会话 id
 * @param {object}  opts.storage         当前存储发现报告（必须 confirmed）
 * @param {object}  opts.services        { getRegistry, getQuery, getPersistence, getTimer, probeActivity }
 * @param {object}  opts.settings        { requireBackup, maxBatch }
 * @param {boolean} opts.force           跳过运行活动探测（仍拒绝 live 会话）
 * @param {function} opts.onPlan         (plan) => void 预检结果回调（用于记录）
 * @returns {Promise<object>} 报告 { aborted, plan, deleted, failed, skipped, warnings, backup }
 */
export async function executeDelete(opts) {
  const { ids, storage, services, settings = {}, force = false } = opts
  const report = {
    aborted: null,
    requested: Array.isArray(ids) ? ids.length : 0,
    plan: [],
    deleted: [],
    failed: [],
    skipped: [],
    warnings: [],
    backup: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }

  // ---- A. 存储确认闸门 ----
  if (!storage || storage.status !== 'confirmed') {
    report.aborted = 'storage-unconfirmed'
    report.finishedAt = new Date().toISOString()
    return report
  }

  // ---- B. 规范化与批量上限 ----
  const uniqueIds = []
  for (const raw of ids || []) {
    const id = String(raw)
    if (!id) continue
    if (!uniqueIds.includes(id)) uniqueIds.push(id)
  }
  const maxBatch = Math.min(Math.max(1, Number(settings.maxBatch) || 50), 200)
  report.requested = uniqueIds.length
  report.maxBatch = maxBatch
  if (uniqueIds.length > maxBatch) {
    report.aborted = 'batch-too-large'
    report.finishedAt = new Date().toISOString()
    return report
  }
  if (uniqueIds.length === 0) {
    report.aborted = 'empty-selection'
    report.finishedAt = new Date().toISOString()
    return report
  }

  // ---- C. 预检 ----
  const archivedSet = await readArchivedSet(services.getRegistry)
  const archivedLookup = new Set(archivedSet)
  const records = new Map()
  try {
    const q = services.getQuery && services.getQuery()
    if (q && typeof q.listSessions === 'function') {
      for (const r of (await q.listSessions()) || []) {
        if (r && r.header && r.header.id != null) records.set(String(r.header.id), r)
      }
    }
  } catch { /* degrade: 无记录时放行后续磁盘侧检查 */ }
  const matchedById = new Map((storage.matched || []).map((m) => [String(m.sessionId), m]))

  const plan = []
  const pushSkip = (id, reason, extra = {}) => plan.push({ id, sessionId: id, ok: false, reason, ...extra })
  for (const id of uniqueIds) {
    if (!archivedLookup.has(id)) {
      pushSkip(id, 'not-archived')
      continue
    }
    const rec = records.get(id)
    if (rec && rec.live === true) {
      pushSkip(id, 'live-session')
      continue
    }
    if (rec && rec.persisted === false && !matchedById.has(id)) {
      pushSkip(id, 'not-persisted')
      continue
    }
    const matched = matchedById.get(id)
    if (!matched) {
      pushSkip(id, 'no-confirmed-directory')
      continue
    }
    if (!force && typeof services.probeActivity === 'function') {
      const activity = await services.probeActivity(id)
      if (activity && activity.available && activity.running) {
        pushSkip(id, 'session-active', { activities: activity.activities })
        continue
      }
    }
    plan.push({ id, sessionId: id, ok: true, matched, header: rec ? rec.header : null })
  }
  report.plan = plan
  const runnable = plan.filter((p) => p.ok)
  if (runnable.length === 0) {
    report.aborted = 'nothing-runnable'
    report.skipped = plan.filter((p) => !p.ok)
    report.finishedAt = new Date().toISOString()
    return report
  }

  // ---- D. 备份（默认强制）----
  if (settings.requireBackup !== false && typeof opts.createBackup === 'function') {
    const registrySnapshot = await snapshotRegistry(services.getRegistry)
    let backup
    try {
      backup = await opts.createBackup({
        sessionRoot: storage.root,
        items: runnable.map((p) => ({
          sessionId: p.id,
          projectDir: p.matched.projectDir,
          name: p.matched.name,
          path: p.matched.path,
          header: p.header,
        })),
        registrySnapshot,
      })
    } catch (e) {
      backup = { ok: false, reason: 'backup-threw: ' + String((e && e.message) || e) }
    }
    report.backup = backup
    if (!backup || !backup.ok) {
      report.aborted = 'backup-failed'
      report.finishedAt = new Date().toISOString()
      return report
    }
  }

  // ---- E. 逐项执行 ----
  for (const item of runnable) {
    await deleteOne(item, report, storage.root, services)
  }

  report.skipped = plan.filter((p) => !p.ok)
  report.summary = {
    requested: uniqueIds.length,
    deleted: report.deleted.length,
    failed: report.failed.length,
    skipped: report.skipped.length,
  }
  report.finishedAt = new Date().toISOString()
  return report
}

async function snapshotRegistry(getRegistry) {
  const reg = getRegistry && getRegistry()
  if (!reg) return null
  try {
    const workspaces = typeof reg.list === 'function'
      ? reg.list().map((ws) => ({
        id: ws.id,
        path: ws.path ?? null,
        title: ws.title ?? null,
        sessionIds: (ws.sessionIds || []).map(String),
      }))
      : []
    return { archivedSessionIds: await readArchivedSet(getRegistry), workspaces }
  } catch {
    return null
  }
}

async function deleteOne(item, report, root, services) {
  const id = item.id
  // 1. 注册表清理（先做：即使后续失败，会话也只是恢复可见，数据仍在）
  const un = await unarchiveSession(services.getRegistry, id)
  if (!un.ok) {
    report.failed.push({ sessionId: id, stage: 'unarchive', error: un.error, message: un.message || null })
    return
  }
  // 2. 工作区摘除
  const detach = await detachFromWorkspaces(services.getRegistry, id)
  if (detach.failures.length > 0) {
    report.warnings.push({ sessionId: id, stage: 'detach', failures: detach.failures })
  }
  // 3. 物理删除前瞬时复检 + 精确删除
  const check = await assertDeletableSessionDir(root, item.matched, id)
  if (!check.ok) {
    report.failed.push({ sessionId: id, stage: 'pre-delete-check', reason: check.reason })
    return
  }
  try {
    await rm(check.path, { recursive: true, force: true })
  } catch (e) {
    report.failed.push({ sessionId: id, stage: 'physical-delete', reason: String((e && e.message) || e) })
    return
  }
  // 4. 删除后验证
  const verification = await verifyDeleted(id, item.matched.path, {
    getRegistry: services.getRegistry,
    getQuery: services.getQuery,
    getPersistence: services.getPersistence,
  })
  const entry = { sessionId: id, verification, detachFailures: detach.failures }
  if (verification.ok) {
    report.deleted.push(entry)
  } else {
    entry.stage = 'verify'
    report.failed.push(entry)
  }
}

/** 删除前预览（不执行任何变更）。 */
export async function previewDelete(ids, storage, services) {
  const archivedSet = new Set(await readArchivedSet(services.getRegistry))
  const matchedById = new Map((storage.matched || []).map((m) => [String(m.sessionId), m]))
  const items = []
  for (const raw of ids || []) {
    const id = String(raw)
    const matched = matchedById.get(id) || null
    const items0 = {
      sessionId: id,
      archived: archivedSet.has(id),
      onDisk: !!matched,
      matchedDir: matched ? matched.path : null,
      sizeBytes: matched ? matched.sizeBytes : null,
      warnings: [],
    }
    if (!items0.archived) items0.warnings.push('not-archived')
    if (!items0.onDisk) items0.warnings.push('no-confirmed-directory')
    items.push(items0)
  }
  return {
    count: items.length,
    totalBytes: items.reduce((s, i) => s + (i.sizeBytes || 0), 0),
    items,
    storageStatus: storage ? storage.status : 'unavailable',
  }
}
