/**
 * enrich.js — 归档会话富化与筛选（Archived Session Cleaner）
 *
 * 输入：归档集合 id 列表 + 服务访问器；输出：带标题/统计/工作区/体积/血脉的完整列表。
 * 纯函数部分（applyFilters）与客户端保持一致语义。
 */

const STATS_TTL = 5 * 60 * 1000
const STATS_CAP = 256

function isTextBlock(b) {
  return b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string'
}

function textOfBlocks(content) {
  return Array.isArray(content) ? content.filter(isTextBlock).map((b) => b.text).join('\n') : ''
}

/** 从 readSurface 事件流提炼统计（与 dsh-unarchive 预览统计同口径）。 */
export function statsFromEvents(events) {
  let userMessages = 0
  let assistantMessages = 0
  let toolResultCount = 0
  let toolCallBlocks = 0
  let lastActivityAt = null
  const list = Array.isArray(events) ? events : []
  for (const ev of list) {
    const t = typeof ev?.time === 'number' ? ev.time : null
    if (t !== null && (lastActivityAt === null || t > lastActivityAt)) lastActivityAt = t
    const type = ev && ev.type
    const data = ev && ev.data
    // user/message carries content on the event data; assistant/message and
    // tool/result carry the message one level down. Read both shapes.
    const content = Array.isArray(data && data.content)
      ? data.content
      : (data && data.message && Array.isArray(data.message.content) ? data.message.content : undefined)
    if (type === 'user/message') {
      userMessages += 1
    } else if (type === 'assistant/message') {
      assistantMessages += 1
      if (Array.isArray(content)) for (const b of content) if (b && b.type === 'tool-call') toolCallBlocks += 1
    } else if (type === 'tool/result') {
      toolResultCount += 1
      if (Array.isArray(content)) for (const b of content) if (b && b.type === 'tool-call') toolCallBlocks += 1
    }
  }
  return {
    userMessages,
    assistantMessages,
    toolCalls: Math.max(toolCallBlocks, toolResultCount),
    lastActivityAt,
    eventCount: list.length,
  }
}

/** 「空会话」判定：没有任何用户/助手/工具活动（仅系统事件的会话视为空）。 */
export function isEmptyStats(stats) {
  if (!stats) return false
  return stats.userMessages === 0 && stats.assistantMessages === 0 && stats.toolCalls === 0
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let idx = 0
  const size = Math.max(1, Math.min(limit, items.length || 1))
  const workers = Array.from({ length: size }, async () => {
    while (idx < items.length) {
      const i = idx
      idx += 1
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        results[i] = { error: String((e && e.message) || e) }
      }
    }
  })
  await Promise.all(workers)
  return results
}

export function makeStatsEngine(getQuery, getTimer) {
  const cache = new Map()
  const timeoutOf = (ms, fallback) => {
    const timer = getTimer()
    if (timer && typeof timer.timeout === 'function') return timer.timeout(ms)
    return new Promise((resolve) => setTimeout(resolve, ms)).then(() => fallback)
  }
  return async function statsFor(sessionId) {
    const hit = cache.get(sessionId)
    if (hit && Date.now() - hit.at < STATS_TTL) return hit.value
    const q = getQuery()
    let value = null
    if (q && typeof q.readSurface === 'function') {
      try {
        const surface = await Promise.race([
          Promise.resolve(q.readSurface(sessionId)).catch(() => null),
          timeoutOf(4000, null),
        ])
        if (surface && Array.isArray(surface.events)) value = statsFromEvents(surface.events)
      } catch {
        value = null
      }
    }
    if (cache.size >= STATS_CAP) cache.delete(cache.keys().next().value)
    cache.set(sessionId, { at: Date.now(), value })
    return value
  }
}

export function makeLineageEngine(getQuery, getTimer) {
  const timeoutOf = (ms) => {
    const timer = getTimer()
    if (timer && typeof timer.timeout === 'function') return timer.timeout(ms)
    return new Promise((resolve) => setTimeout(resolve, ms)).then(() => null)
  }
  const countDescendants = (nodes) =>
    (Array.isArray(nodes) ? nodes : []).reduce((s, n) => s + 1 + countDescendants(n?.descendants), 0)
  return async function lineageFor(sessionId) {
    const q = getQuery()
    if (!q || typeof q.traceSession !== 'function') return null
    try {
      const trace = await Promise.race([
        Promise.resolve(q.traceSession(sessionId)).catch(() => null),
        timeoutOf(3000),
      ])
      if (!trace) return null
      return {
        ancestorCount: Array.isArray(trace.ancestors) ? trace.ancestors.length : 0,
        descendantCount: countDescendants(trace.descendants),
      }
    } catch {
      return null
    }
  }
}

export function chunk(list, size) {
  const out = []
  const arr = Array.isArray(list) ? list : []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * 富化完整列表。services: { getRegistry, getQuery, statsFor, lineageFor }
 * storageMatched: [{ sessionId, sizeBytes, path, name, projectDir }] | null
 */
export async function enrichArchivedSessions(archivedIds, services, storageMatched) {
  const { getRegistry, getQuery, statsFor, lineageFor } = services
  const ids = archivedIds.map((x) => String(x))

  // 1. records（header/live/persisted）
  const records = new Map()
  try {
    const q = getQuery()
    if (q && typeof q.listSessions === 'function') {
      for (const r of (await q.listSessions()) || []) {
        if (r && r.header && r.header.id != null) records.set(String(r.header.id), r)
      }
    }
  } catch { /* degrade */ }

  // 2. titles（批量）
  const titles = new Map()
  try {
    const q = getQuery()
    if (q && typeof q.readTitleSnapshots === 'function') {
      for (const part of chunk(ids, 100)) {
        const obs = (await q.readTitleSnapshots(part)) || []
        for (const o of obs) {
          if (o && o.status === 'fulfilled' && o.value && o.value.title && typeof o.value.title.title === 'string') {
            titles.set(String(o.sessionId), o.value.title.title)
          }
        }
      }
    }
  } catch { /* degrade */ }

  // 3. workspace membership
  const wsBySession = new Map()
  try {
    for (const ws of (getRegistry()?.list?.() || [])) {
      for (const sid of ws.sessionIds || []) {
        const k = String(sid)
        if (!wsBySession.has(k)) {
          wsBySession.set(k, { workspaceId: ws.id, workspaceTitle: ws.title ?? null, workspacePath: ws.path ?? null })
        }
      }
    }
  } catch { /* degrade */ }

  // 4. 磁盘匹配（体积）
  const matchedById = new Map()
  for (const m of storageMatched || []) matchedById.set(String(m.sessionId), m)

  // 5. stats + lineage（并发受限）
  const statsList = await mapLimit(ids, 4, (id) => statsFor(id))
  const lineageList = await mapLimit(ids, 2, (id) => lineageFor(id))

  const items = ids.map((id, i) => {
    const rec = records.get(id)
    const stats = statsList[i] && !statsList[i].error ? statsList[i] : null
    const matched = matchedById.get(id) || null
    const lineage = lineageList[i] && !lineageList[i].error ? lineageList[i] : null
    const header = rec ? rec.header : null
    return {
      sessionId: id,
      title: titles.get(id) ?? null,
      archivedAt: null, // DSH 的归档集合只存 id，不记录归档时间
      createdAt: header && typeof header.createdAt === 'number' ? header.createdAt : null,
      origin: header && header.origin ? header.origin : null,
      cwd: header && typeof header.cwd === 'string' ? header.cwd : null,
      parentSession: header && header.parentSession ? header.parentSession : null,
      live: rec ? !!rec.live : null,
      persisted: rec ? !!rec.persisted : null,
      workspaceTitle: wsBySession.get(id)?.workspaceTitle ?? null,
      workspacePath: wsBySession.get(id)?.workspacePath ?? null,
      workspaceId: wsBySession.get(id)?.workspaceId ?? null,
      stats,
      empty: isEmptyStats(stats),
      sizeBytes: matched ? matched.sizeBytes : null,
      onDisk: !!matched,
      matchedDir: matched ? matched.path : null,
      lineage,
    }
  })
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return items
}

/** Parse a `YYYY-MM-DD` filter as local midnight so UI and server agree. */
function dayStart(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const time = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  return Number.isFinite(time) ? time : null
}

/** 服务端筛选（与客户端同语义；客户端本地再筛一次以保证即时响应）。 */
export function applyFilters(items, f = {}) {
  let out = items
  if (f.keyword) {
    const kw = String(f.keyword).toLowerCase()
    out = out.filter((it) => (it.title || '').toLowerCase().includes(kw) || it.sessionId.toLowerCase().includes(kw))
  }
  if (f.emptyOnly) out = out.filter((it) => it.empty)
  if (f.subagentOnly) out = out.filter((it) => it.origin === 'subagent')
  if (f.timeField !== 'lastActivity') {
    if (f.from) {
      const t = dayStart(f.from)
      if (t !== null) out = out.filter((it) => (it.createdAt ?? 0) >= t)
    }
    if (f.to) {
      const t = dayStart(f.to)
      if (t !== null) out = out.filter((it) => (it.createdAt ?? 0) <= t + 24 * 3600 * 1000 - 1)
    }
  } else {
    if (f.from) {
      const t = dayStart(f.from)
      if (t !== null) out = out.filter((it) => (it.stats?.lastActivityAt ?? 0) >= t)
    }
    if (f.to) {
      const t = dayStart(f.to)
      if (t !== null) out = out.filter((it) => (it.stats?.lastActivityAt ?? 0) <= t + 24 * 3600 * 1000 - 1)
    }
  }
  if (typeof f.minSizeBytes === 'number' && f.minSizeBytes > 0) {
    out = out.filter((it) => (it.sizeBytes ?? 0) >= f.minSizeBytes)
  }
  return out
}
