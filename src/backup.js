/**
 * backup.js — 备份导出、校验与备份清理（Archived Session Cleaner）
 *
 * 备份 = 完整会话目录副本 + manifest.json + sha256 逐文件校验。
 * 导出 = 内存中构建 tar.gz（ustar，无第三方依赖）。
 * 删除会话由 pipeline.js 执行；本模块只删除用户明确选中的历史备份目录。
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, readdir, readFile, stat, writeFile, rm, lstat } from 'node:fs/promises'
import { join, basename } from 'node:path'

/** 备份目录名由 createBackup 生成：<timestamp>_<hex>。 */
export const BACKUP_ID_RE = /^[0-9A-Za-z_-]{8,80}$/

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 会话 id → 备份内存根目录名用的安全段（保持可读 + 防碰撞）。 */
export function safeSegment(sessionId) {
  let s = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')
  if (s.length > 48) s = s.slice(0, 48)
  const suffix = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8)
  return `${s || 'session'}.${suffix}`
}

async function copySessionDir(srcDir, destDir) {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const data = await readFile(join(srcDir, entry.name))
    await writeFile(join(destDir, entry.name), data)
    files.push({ name: entry.name, sizeBytes: data.length, sha256: sha256(data) })
  }
  return files
}

/**
 * 创建备份：把每个计划删除的会话目录完整复制到 backups/<backupId>/sessions/<seg>/，
 * 写 manifest.json（含注册表快照，供人工恢复），然后逐文件 sha256 校验。
 *
 * @param {object} opts
 * @param {string} opts.backupsDir   备份根目录（plugin 数据目录下）
 * @param {string} opts.sessionRoot  已确认的会话日志 root
 * @param {Array}  opts.items        [{ sessionId, projectDir, name, path, header? }]
 * @param {object} opts.registrySnapshot { archivedSessionIds, workspaces: [{id,path,title,sessionIds}] }
 * @returns {Promise<{ok:boolean, backupId?:string, dir?:string, reason?:string, files?:number, bytes?:number}>}
 */
export async function createBackup(opts) {
  const { backupsDir, sessionRoot, items, registrySnapshot } = opts
  if (!backupsDir || !Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: 'nothing-to-back-up' }
  }
  const now = new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const rand = createHash('sha256').update(String(now.getTime()) + String(items.length)).digest('hex').slice(0, 6)
  const backupId = `${stamp}_${rand}`
  const dir = join(backupsDir, backupId)
  try {
    await mkdir(dir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: 'backup-dir-unavailable: ' + String(e && e.message ? e.message : e) }
  }

  const manifestItems = []
  let totalBytes = 0
  let totalFiles = 0
  try {
    for (const item of items) {
      const seg = safeSegment(item.sessionId)
      const files = await copySessionDir(item.path, join(dir, 'sessions', seg))
      manifestItems.push({
        sessionId: item.sessionId,
        projectDir: item.projectDir,
        sessionDir: item.name,
        relativePath: `sessions/${seg}`,
        files,
        header: item.header ?? null,
      })
      totalBytes += files.reduce((s, f) => s + f.sizeBytes, 0)
      totalFiles += files.length
    }
  } catch (e) {
    return { ok: false, backupId, dir, reason: 'copy-failed: ' + String(e && e.message ? e.message : e) }
  }

  const manifest = {
    plugin: 'dsh-archived-session-cleaner',
    format: 1,
    createdAt: now.toISOString(),
    sessionRoot,
    registrySnapshot: registrySnapshot ?? null,
    items: manifestItems,
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const verification = await verifyBackupDir(dir, manifest)
  if (!verification.ok) {
    return { ok: false, backupId, dir, reason: verification.reason, files: totalFiles, bytes: totalBytes }
  }
  return { ok: true, backupId, dir, files: totalFiles, bytes: totalBytes, manifestPath: join(dir, 'manifest.json') }
}

/** 逐文件 sha256 + 体积复核副本与源一致。 */
export async function verifyBackupDir(dir, manifest) {
  try {
    for (const item of manifest.items) {
      for (const file of item.files) {
        const p = join(dir, item.relativePath, file.name)
        const st = await stat(p)
        if (!st.isFile() || st.size !== file.sizeBytes) {
          return { ok: false, reason: `size-mismatch:${item.sessionId}/${file.name}` }
        }
        const data = await readFile(p)
        if (sha256(data) !== file.sha256) {
          return { ok: false, reason: `sha256-mismatch:${item.sessionId}/${file.name}` }
        }
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'verify-failed: ' + String(e && e.message ? e.message : e) }
  }
}

/** 递归收集备份目录中的所有文件（用于打包下载）。 */
export async function collectBackupFiles(dir) {
  const out = []
  const walk = async (rel) => {
    const abs = join(dir, rel)
    const entries = await readdir(abs, { withFileTypes: true })
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(childRel)
      else if (entry.isFile()) {
        const data = await readFile(join(dir, childRel))
        out.push({ name: childRel.replace(/\\/g, '/'), data })
      }
    }
  }
  await walk('')
  return out
}

/** 列出已有备份（读 manifest 摘要，不加载全部内容）。 */
export async function listBackups(backupsDir) {
  let entries
  try {
    entries = await readdir(backupsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(join(backupsDir, entry.name, 'manifest.json'), 'utf8'))
      out.push({
        backupId: entry.name,
        createdAt: manifest.createdAt,
        sessionCount: (manifest.items || []).length,
        sessionIds: (manifest.items || []).map((i) => i.sessionId),
        bytes: (manifest.items || []).reduce(
          (s, i) => s + (i.files || []).reduce((t, f) => t + f.sizeBytes, 0), 0,
        ),
      })
    } catch {
      out.push({ backupId: entry.name, createdAt: null, sessionCount: 0, sessionIds: [], bytes: 0, unreadable: true })
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/**
 * Delete one historical backup directory by exact, validated id.
 * Only directories directly below `backupsDir` whose generated name matches
 * BACKUP_ID_RE can be removed; a symlink is removed as a link, not followed.
 */
export async function deleteBackup(backupsDir, backupId) {
  const id = String(backupId || '')
  if (!BACKUP_ID_RE.test(id)) return { ok: false, reason: 'invalid-backup-id' }
  const dir = join(backupsDir, id)
  try {
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) return { ok: false, reason: 'not-a-directory' }
  } catch {
    return { ok: false, reason: 'backup-not-found' }
  }
  try {
    await rm(dir, { recursive: true, force: true })
    return { ok: true, backupId: id }
  } catch (e) {
    return { ok: false, reason: 'delete-failed', message: String((e && e.message) || e) }
  }
}

// ---------------------------------------------------------------------------
// 最小 ustar tar + gzip（无第三方依赖）
// ---------------------------------------------------------------------------

function octalField(value, width) {
  return Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, '0') + '\0'
}

function tarHeader(name, sizeBytes, mtimeSec, typeflag) {
  const buf = Buffer.alloc(512)
  buf.write(name.slice(0, 100), 0, 'utf8')
  buf.write(octalField(0o644, 8), 100, 'ascii') // mode
  buf.write(octalField(0, 8), 108, 'ascii') // uid
  buf.write(octalField(0, 8), 116, 'ascii') // gid
  buf.write(octalField(sizeBytes, 12), 124, 'ascii') // size
  buf.write(octalField(mtimeSec, 12), 136, 'ascii') // mtime
  buf.write('        ', 148, 8, 'ascii') // chksum = spaces
  buf.write(typeflag, 156, 1, 'ascii') // '0' file / '5' dir
  buf.write('ustar\0', 257, 6, 'ascii')
  buf.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of buf) sum += b
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return buf
}

function tarEntry(name, data, typeflag, mtimeSec) {
  const isDir = typeflag === '5'
  const body = isDir ? Buffer.alloc(0) : data
  const header = tarHeader(name, isDir ? 0 : body.length, mtimeSec, typeflag)
  const parts = [header]
  if (!isDir && body.length > 0) {
    parts.push(body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  return Buffer.concat(parts)
}

/** 由文件列表（相对路径 + Buffer）构建 .tar.gz。目录项自动前置。 */
export function buildTarGz(entries, mtimeSec = Math.floor(Date.now() / 1000)) {
  const fileNames = entries.map((e) => e.name).sort()
  const dirs = new Set()
  for (const name of fileNames) {
    const parts = name.split('/')
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      dirs.add(prefix)
    }
  }
  const chunks = []
  for (const dir of [...dirs].sort()) chunks.push(tarEntry(`${dir}/`, Buffer.alloc(0), '5', mtimeSec))
  for (const name of fileNames) {
    const entry = entries.find((e) => e.name === name)
    chunks.push(tarEntry(name, entry.data, '0', mtimeSec))
  }
  chunks.push(Buffer.alloc(1024)) // 两块全零结束块
  return gzipSync(Buffer.concat(chunks), { level: 6 })
}

export { basename }
