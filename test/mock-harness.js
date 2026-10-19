/**
 * mock-harness.js — 离线模拟 DSH 宿主（测试专用）
 *
 * 按官方契约模拟：
 *   workspaceRegistry（archivedSessionIds / unarchiveSession / list / Workspace.detachSession
 *     / requireState / setState / enqueueOperation）
 *   sessionQuery（listSessions / readTitleSnapshots / readSurface / traceSession）
 *   sessionPersistence（stat / list，镜像真实磁盘状态）
 *   webServer（register：exact / prefix，node http 风格 handler）
 *   timer / ctx.get / ctx.inject / ctx.effect / ctx.on/off / ctx.waterfall
 *
 * 磁盘按 JSONL provider 真实布局落盘：
 *   <root>/--<project>--/<sessionId>/session.jsonl[.zstd]、session.vN.jsonl、session.lock
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const PROJECT_DIR = '--mock-project--'

export const ULID = (n) => `01HZX${String(n).padStart(4, '0')}MOCKMOCKMOCKMOCK${String(n).padStart(3, '0')}`

export async function makeHarness(options = {}) {
  const {
    sessions: sessionSpecs = [
      { idx: 1, archived: true, title: '旧版登录重构', origin: 'user', empty: false, daysAgo: 30, userMsgs: 12 },
      { idx: 2, archived: true, title: '测试空会话', origin: 'user', empty: true, daysAgo: 10, userMsgs: 0 },
      { idx: 3, archived: true, title: 'subagent 会话', origin: 'subagent', empty: false, daysAgo: 5, userMsgs: 3 },
      { idx: 4, archived: false, title: '活跃会话', origin: 'user', empty: false, daysAgo: 1, userMsgs: 40, live: true },
      { idx: 5, archived: true, title: null, origin: 'user', empty: false, daysAgo: 60, userMsgs: 7 },
    ],
    sessionRoot: configuredRoot = '',
    activities = {},
    failPhysicalDelete = false,
    pluginDataDir,
  } = options

  const base = await mkdtemp(join(tmpdir(), 'asc-mock-'))
  const root = options.root || join(base, 'session-logs')
  const dataDir = pluginDataDir || join(base, 'plugin-data')

  const now = Date.now()
  const day = 24 * 3600 * 1000
  const sessions = sessionSpecs.map((spec) => ({
    id: ULID(spec.idx),
    title: spec.title ?? null,
    origin: spec.origin || 'user',
    empty: !!spec.empty,
    createdAt: now - (spec.daysAgo || 1) * day,
    lastActivityAt: now - (spec.daysAgo || 1) * day + 60000,
    userMsgs: spec.userMsgs ?? 0,
    live: !!spec.live,
    archived: !!spec.archived,
    parentSession: null,
    dir: null,
  }))
  const specById = new Map()
  for (const spec of sessionSpecs) specById.set(ULID(spec.idx), spec)
  const spec_of = (s) => specById.get(s.id)

  // ---- 落盘（真实布局） ----
  await mkdir(root, { recursive: true })
  for (const s of sessions) {
    if (spec_of(s) && spec_of(s).noDir) continue // 归档但无磁盘目录的会话
    const dir = join(root, PROJECT_DIR, s.id)
    s.dir = dir
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), JSON.stringify({ v: 0, id: s.id }) + '\n', 'utf8')
    await writeFile(join(dir, 'session.v3.jsonl'), JSON.stringify({ v: 3, id: s.id }) + '\n', 'utf8')
    await writeFile(join(dir, 'session.lock'), '', 'utf8')
    const spec = spec_of(s)
    if (spec && spec.withSubdir) {
      await mkdir(join(dir, 'unexpected-subdir'), { recursive: true })
    }
  }

  // ---- workspaceRegistry mock ----
  const registryState = {
    archivedSessionIds: sessions.filter((s) => s.archived).map((s) => s.id),
  }
  const unarchiveCalls = []
  // workspace 实体只创建一次：detachSession 的修改必须持久（list() 每次返回同一对象）
  const workspace = {
    id: 'ws-mock-1',
    path: 'C:/mock/project',
    title: 'mock-project',
    createdAt: new Date(now - 90 * day).toISOString(),
    sessionIds: sessions.map((s) => s.id),
    async detachSession(id) {
      const i = this.sessionIds.indexOf(id)
      if (i >= 0) this.sessionIds.splice(i, 1)
    },
  }
  const registry = {
    get archivedSessionIds() { return registryState.archivedSessionIds },
    unarchiveSession: async (id) => {
      unarchiveCalls.push(id)
      const i = registryState.archivedSessionIds.indexOf(id)
      if (i >= 0) registryState.archivedSessionIds.splice(i, 1)
    },
    list: () => [workspace],
    requireState: () => registryState,
    setState: async (next) => {
      registryState.archivedSessionIds = Array.isArray(next.archivedSessionIds) ? [...next.archivedSessionIds] : []
    },
    enqueueOperation: async (fn) => fn(),
  }

  // ---- sessionQuery mock ----
  const surfaceCalls = []
  const query = {
    listSessions: async () => sessions.map((s) => ({
      header: {
        id: s.id,
        origin: s.origin,
        createdAt: s.createdAt,
        cwd: 'C:/mock/project',
        parentSession: s.parentSession,
        isSeeded: false,
      },
      live: s.live,
      persisted: true,
      formatStatus: 'current',
    })),
    readTitleSnapshots: async (ids) => ids.map((id) => {
      const s = sessions.find((x) => x.id === id)
      return {
        sessionId: id,
        status: 'fulfilled',
        value: { session: { id }, title: s && s.title ? { title: s.title } : undefined },
      }
    }),
    readSurface: async (id) => {
      surfaceCalls.push(id)
      const s = sessions.find((x) => x.id === id)
      if (!s) throw new Error('session-not-found: ' + id)
      const events = []
      const base = s.createdAt
      if (s.userMsgs > 0) {
        events.push({ time: base, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })
        events.push({
          time: base + 1000,
          type: 'assistant/message',
          data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, stream: [] },
        })
        for (let i = 1; i < s.userMsgs; i += 1) {
          events.push({ time: base + i * 2000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `msg ${i}` }] } })
          events.push({
            time: base + i * 2000 + 500,
            type: 'assistant/message',
            data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: `ok ${i}` }] }, stream: [] },
          })
          if (i % 3 === 0) {
            events.push({
              time: base + i * 2000 + 600,
              type: 'tool/result',
              data: { turn: 0, step: 0, message: { role: 'tool', content: [{ type: 'tool-call' }] } },
            })
          }
        }
      }
      events.push({ time: s.lastActivityAt, type: 'system/message', data: { turn: 0, step: 0, message: { role: 'system', content: [] } } })
      return { session: { id }, events }
    },
    traceSession: async (id) => ({ target: { header: { id } }, ancestors: [], descendants: [] }),
  }

  // ---- sessionPersistence mock（镜像磁盘） ----
  const dirExists = async (p) => { try { await stat(p); return true } catch { return false } }
  const persistence = {
    stat: async (id) => {
      const s = sessions.find((x) => x.id === id)
      if (!s || !(await dirExists(s.dir))) return undefined
      return { header: { id: s.id, createdAt: s.createdAt, origin: s.origin }, sizeBytes: 1024, persisted: true, formatStatus: 'current' }
    },
    list: async () => {
      const out = []
      for (const s of sessions) {
        if (await dirExists(s.dir)) {
          out.push({ header: { id: s.id, createdAt: s.createdAt, origin: s.origin }, sizeBytes: 1024 })
        }
      }
      return out
    },
  }

  // ---- timer / ctx ----
  const timer = { timeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

  const services = {
    workspaceRegistry: registry,
    sessionQuery: query,
    sessionPersistence: persistence,
    timer,
  }

  const routes = []
  const webServer = { register: (entry) => routes.push(entry) }

  const ctx = {
    webServer,
    get: (name) => services[name],
    inject: (names, cb) => cb(ctx),
    effect: (cb) => cb(),
    on: () => {}, off: () => {},
    emit: () => {},
    parallel: async () => {},
    waterfall: async (event, request, next) => {
      if (event === 'workspace/session-activity') {
        const list = activities[request.sessionId]
        if (Array.isArray(list) && list.length > 0) return list
      }
      return typeof next === 'function' ? next() : []
    },
  }

  // ---- 进程内 HTTP 调用器 ----
  async function invoke(method, url, body) {
    const path = url.split('?')[0]
    let entry = null
    for (const r of routes) {
      if (r.kind === 'exact' && r.path === path) { entry = r; break }
      if (r.kind === 'prefix' && path.startsWith(r.path)) { entry = r; break }
    }
    if (!entry) return { status: 404, body: { error: 'no-route' } }
    const req = new EventEmitter()
    req.method = method
    req.url = url
    const res = {
      statusCode: null, headers: null, chunks: [],
      writeHead(status, headers) { this.statusCode = status; this.headers = headers },
      end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.finished = true },
    }
    const done = new Promise((resolve) => {
      const origEnd = res.end.bind(res)
      res.end = (chunk) => { origEnd(chunk); resolve() }
    })
    const handlerPromise = entry.handler(req, res)
    if (body !== undefined && body !== null) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    }
    req.emit('end')
    await done
    const raw = Buffer.concat(res.chunks).toString('utf8')
    let parsed = null
    try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = raw }
    return { status: res.statusCode, headers: res.headers, body: parsed, raw: Buffer.concat(res.chunks) }
  }

  // ---- 挂载被测插件 ----
  const plugin = await import('../src/index.js')
  const config = { sessionRoot: configuredRoot, requireBackup: true, maxBatch: 50 }
  // 隔离设置目录，避免上一个用例的设置残留影响默认值
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    await rm(join(dshHome, 'archived-session-cleaner'), { recursive: true, force: true })
  } catch { /* ignore */ }
  plugin.apply(ctx, config)
  // 等待 settings 文件异步加载（不影响内存默认值）
  await new Promise((r) => setTimeout(r, 20))

  return {
    base, root, dataDir, sessions, registry, registryState, query, persistence, ctx, routes, invoke,
    unarchiveCalls, surfaceCalls,
    archivedIds: () => [...registryState.archivedSessionIds],
    workspaceSessionIds: () => [...registry.list()[0].sessionIds],
    async cleanup() {
      await rm(base, { recursive: true, force: true })
    },
  }
}

export { PROJECT_DIR }
