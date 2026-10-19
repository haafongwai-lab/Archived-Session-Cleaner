/**
 * routes.js — HTTP API 路由层（Archived Session Cleaner）
 *
 * 所有路由挂在 /dsh-asc/api 前缀下，经 webServer.register 注册
 * （kind: 'exact' | 'prefix'，与 dsh-unarchive 验证过的 webServer route contract 一致）。
 */
import { join } from 'node:path'
import { buildTarGz, collectBackupFiles, listBackups } from './backup.js'

const PREFIX = '/dsh-asc/api'
const MAX_BODY_BYTES = 1024 * 1024
/** Backup ids are generated as `<stamp>_<hex>`; anything else must never reach join(). */
const BACKUP_ID_RE = /^[0-9A-Za-z_-]{8,80}$/

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('request-body-too-large'))
        return
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const asIdArray = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])

/**
 * @param {object} ctx webServer 子上下文（ctx.inject(['webServer'], sub) 注入）
 * @param {object} api  由 index.js 装配好的 API 面
 */
export function registerRoutes(ctx, api) {
  const { getCapabilities, getStorage, refreshStorage, listArchived, preview, createBackup, runDelete, getSettings, setSettings, getBackupsDir } = api

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/capabilities`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        sendJson(res, 200, await getCapabilities())
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/storage`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        sendJson(res, 200, await getStorage(false))
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/storage/refresh`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        sendJson(res, 200, await refreshStorage())
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/sessions`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        const url = new URL(req.url, 'http://dsh.local')
        const filters = {}
        if (url.searchParams.get('keyword')) filters.keyword = url.searchParams.get('keyword')
        if (url.searchParams.get('empty')) filters.emptyOnly = true
        if (url.searchParams.get('subagent')) filters.subagentOnly = true
        if (url.searchParams.get('from')) filters.from = url.searchParams.get('from')
        if (url.searchParams.get('to')) filters.to = url.searchParams.get('to')
        if (url.searchParams.get('timeField')) filters.timeField = url.searchParams.get('timeField')
        const minSize = Number(url.searchParams.get('minSizeBytes'))
        if (Number.isFinite(minSize) && minSize > 0) filters.minSizeBytes = minSize
        sendJson(res, 200, await listArchived(filters))
      } catch (e) {
        sendJson(res, 500, { total: 0, items: [], error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/preview`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        const body = await readJsonBody(req)
        sendJson(res, 200, await preview(asIdArray(body.ids)))
      } catch (e) {
        sendJson(res, 400, { error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/backup`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        const body = await readJsonBody(req)
        sendJson(res, 200, await createBackup(asIdArray(body.ids)))
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/backups`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        sendJson(res, 200, { items: await listBackups(getBackupsDir()) })
      } catch (e) {
        sendJson(res, 500, { items: [], error: String((e && e.message) || e) })
      }
    },
  })

  // GET /dsh-asc/api/backup/<id>/download → .tar.gz
  ctx.webServer.register({
    kind: 'prefix',
    path: `${PREFIX}/backup/`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      let rest
      try {
        rest = decodeURIComponent((req.url || '').slice(`${PREFIX}/backup/`.length))
      } catch {
        return sendJson(res, 400, { error: 'invalid-backup-id' })
      }
      const match = /^([^/]+)\/download$/.exec(rest)
      // Reject traversal, dots, and encoded separators before they reach join().
      if (!match || !BACKUP_ID_RE.test(match[1])) return sendJson(res, 404, { error: 'not-found' })
      try {
        const dir = getBackupsDir()
        const files = await collectBackupFiles(join(dir, match[1]))
        if (files.length === 0) return sendJson(res, 404, { error: 'backup-not-found' })
        const gz = buildTarGz(files)
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="asc-backup-${match[1]}.tar.gz"`,
          'content-length': String(gz.length),
          'cache-control': 'no-store',
        })
        res.end(gz)
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/delete`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        const body = await readJsonBody(req)
        const report = await runDelete({
          ids: asIdArray(body.ids),
          backupId: typeof body.backupId === 'string' ? body.backupId : null,
          force: body.force === true,
        })
        sendJson(res, 200, report)
      } catch (e) {
        sendJson(res, 500, { aborted: 'internal-error', error: String((e && e.message) || e) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/settings`,
    handler: async (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, await getSettings())
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req)
          sendJson(res, 200, await setSettings(body))
        } catch (e) {
          sendJson(res, 500, { error: String((e && e.message) || e) })
        }
        return undefined
      }
      return sendJson(res, 405, { error: 'method-not-allowed' })
    },
  })
}
