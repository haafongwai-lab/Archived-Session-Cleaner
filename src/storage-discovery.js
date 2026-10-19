/**
 * storage-discovery.js — 存储发现与结构确认（Archived Session Cleaner 的安全核心）
 *
 * 职责：在删除任何文件之前，回答三个问题——
 *   1. 会话日志根目录（root）在哪里？
 *   2. 磁盘上的目录结构是否匹配 JSONL provider 的规范布局？
 *   3. 权威 API（sessionQuery / sessionPersistence）返回的会话 id 是否能在磁盘上找到对应目录？
 *
 * 三者全部满足，root 才被标记为 confirmed；否则删除功能禁用。
 * 本模块不执行任何删除——删除仅由 index.js 的管线在 confirmed 状态下调用。
 *
 * 依赖注入：所有 fs 操作经 `fs` 参数（默认 node:fs/promises），便于测试。
 */
import { readdir, stat as fsStat } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** JSONL provider 的日志文件族：session.jsonl / session.vN.jsonl，可选 .zstd 后缀。 */
export const SESSION_FILE_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
/** 项目目录：--<normalized-cwd>--；无 cwd 时为 _no-cwd/。 */
export const PROJECT_DIR_RE = /^--.+--$/
export const NO_CWD_DIR = '_no-cwd'
/** provider 锁文件名（POSIX flock / Windows 信号量路径派生）。 */
export const LOCK_FILE = 'session.lock'

export const DEFAULT_FS = {
  readdir: (p, o) => readdir(p, o),
  stat: (p) => fsStat(p),
}

/** 目录不存在 / 不可读时静默跳过用的 helper。 */
async function safeReaddir(fs, p, withTypes = true) {
  try {
    return await fs.readdir(p, withTypes ? { withFileTypes: true } : undefined)
  } catch {
    return null
  }
}

async function safeStat(fs, p) {
  try {
    const s = await fs.stat(p)
    return { sizeBytes: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 候选根发现
// ---------------------------------------------------------------------------

/**
 * 按优先级产出候选根目录列表（去重、保序）：
 *   1. 插件配置 sessionRoot（用户显式指定，最可信）
 *   2. 环境变量 DSH_SESSION_ROOT
 *   3. 常见默认位置（~/.dsh/sessions、~/.dsh/profiles/<name>/sessions、<cwd>/.dsh/sessions）
 * 注意：官方 provider 的 root 是必填配置项、无默认值——常见位置只是探测起点，
 *      最终必须靠结构验证 + id 交叉验证说话。
 */
export function candidateRoots(opts = {}) {
  const { configuredRoot = '', env = {}, homedir = osHomedir(), cwd = '' } = opts
  const out = []
  const push = (path, source) => {
    if (typeof path === 'string' && path.trim() && !out.some((c) => c.path === path)) {
      out.push({ path, source })
    }
  }
  push(configuredRoot, 'config')
  if (env && typeof env.DSH_SESSION_ROOT === 'string') push(env.DSH_SESSION_ROOT, 'env')
  const dshHome = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()
    ? env.DSH_HOME
    : (homedir ? join(homedir, '.dsh') : '')
  if (dshHome) {
    push(join(dshHome, 'sessions'), 'common')
    for (const profile of ['web', 'default', 'desktop', 'sdk']) {
      push(join(dshHome, 'profiles', profile, 'sessions'), 'common')
    }
  }
  if (cwd) {
    push(join(cwd, '.dsh', 'sessions'), 'common')
    push(join(cwd, 'sessions'), 'common')
  }
  return out
}

// ---------------------------------------------------------------------------
// 结构探测
// ---------------------------------------------------------------------------

/**
 * 探测单个候选根：枚举 `--*--/`（或 _no-cwd/）项目目录及其下的会话目录。
 * 返回 null 表示根不存在或根本不是目录。
 */
export async function probeRoot(root, fs = DEFAULT_FS) {
  if (typeof root !== 'string' || !root.trim()) return null
  const rootStat = await safeStat(fs, root)
  if (!rootStat || !rootStat.isDirectory) return null

  const top = await safeReaddir(fs, root)
  if (top === null) return null

  const scan = {
    root,
    projectDirs: [],
    sessionDirs: [], // { projectDir, name, path, files: [{ name, path, sizeBytes }], sizeBytes }
  }

  for (const entry of top) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (name !== NO_CWD_DIR && !PROJECT_DIR_RE.test(name)) continue
    const projectPath = join(root, name)
    const projectStat = await safeStat(fs, projectPath)
    if (!projectStat || !projectStat.isDirectory) continue

    const children = await safeReaddir(fs, projectPath)
    if (children === null) continue
    let sessionDirCount = 0
    for (const child of children) {
      if (!child.isDirectory()) continue
      const sessionPath = join(projectPath, child.name)
      const files = await collectSessionFiles(fs, sessionPath)
      if (files.length === 0) continue
      const sizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
      scan.sessionDirs.push({ projectDir: name, name: child.name, path: sessionPath, files, sizeBytes })
      sessionDirCount += 1
    }
    scan.projectDirs.push({ name, path: projectPath, sessionDirCount })
  }

  scan.totalSessionDirs = scan.sessionDirs.length
  return scan
}

/** 收集一个会话目录中的日志文件与锁文件（锁文件计入体积，删除时随目录一并处理）。 */
async function collectSessionFiles(fs, sessionPath) {
  const entries = await safeReaddir(fs, sessionPath)
  if (entries === null) return []
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!SESSION_FILE_RE.test(entry.name) && entry.name !== LOCK_FILE) continue
    const st = await safeStat(fs, join(sessionPath, entry.name))
    if (!st) continue
    files.push({ name: entry.name, path: join(sessionPath, entry.name), sizeBytes: st.sizeBytes })
  }
  return files
}

// ---------------------------------------------------------------------------
// 交叉验证（权威 id ↔ 磁盘目录）
// ---------------------------------------------------------------------------

const normalizeIdSegment = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '')

/**
 * 将权威会话 id 与扫描结果比对。
 * - exact：目录名与 id 完全相等（provider 对安全字符的注入式转义为恒等）。
 * - normalized：仅字母数字/_/- 归一后相等。只作为诊断信号，**不能用于删除**：
 *   归一可能把两个不同 id 折叠到同一目录名，若据此删除会误删别的会话。
 * confirmed 判定与删除都只认 exact 匹配。
 */
export function crossValidate(scan, knownIds) {
  const known = Array.isArray(knownIds) ? knownIds.filter((x) => typeof x === 'string' && x) : []
  const byName = new Map()
  const byNormalized = new Map()
  for (const dir of scan.sessionDirs) {
    if (!byName.has(dir.name)) byName.set(dir.name, [])
    byName.get(dir.name).push(dir)
    const n = normalizeIdSegment(dir.name)
    if (n && !byNormalized.has(n)) byNormalized.set(n, [])
    if (n) byNormalized.get(n).push(dir)
  }

  const matched = []
  const normalizedMatches = []
  const unmatchedKnownIds = []
  for (const id of known) {
    const exact = byName.get(id)
    if (exact && exact.length > 0) {
      matched.push({ sessionId: id, ...pickDir(exact[0]), match: 'exact' })
      continue
    }
    const norm = byNormalized.get(normalizeIdSegment(id))
    if (norm && norm.length > 0) {
      normalizedMatches.push({ sessionId: id, ...pickDir(norm[0]), match: 'normalized' })
      continue
    }
    unmatchedKnownIds.push(id)
  }

  const matchedNames = new Set(matched.map((m) => m.name))
  const orphanDirs = scan.sessionDirs.filter((d) => !matchedNames.has(d.name))
  return { matched, normalizedMatches, unmatchedKnownIds, orphanDirs }
}

function pickDir(dir) {
  return { projectDir: dir.projectDir, name: dir.name, path: dir.path, files: dir.files, sizeBytes: dir.sizeBytes }
}

// ---------------------------------------------------------------------------
// 发现主入口
// ---------------------------------------------------------------------------

/**
 * 完整的存储发现流程：候选根 → 结构探测 → id 交叉验证 → 裁决。
 *
 * @returns {Promise<{
 *   status: 'confirmed'|'unconfirmed'|'unavailable',
 *   root: string|null,
 *   candidates: Array<{ path, source, exists, sessionDirCount }>,
 *   matched: Array<{ sessionId, projectDir, name, path, files, sizeBytes, match }>,
 *   unmatchedKnownIds: string[],
 *   warnings: string[],
 * }>}
 */
export async function discoverStorage(options = {}) {
  const {
    configuredRoot = '',
    env = {},
    homedir = osHomedir(),
    cwd = '',
    knownIds = [],
    fs = DEFAULT_FS,
  } = options

  const warnings = []
  const candidates = candidateRoots({ configuredRoot, env, homedir, cwd })
  const candidateReports = []
  let best = null // { root, scan, cross, exactCount }

  for (const candidate of candidates) {
    const scan = await probeRoot(candidate.path, fs)
    if (scan === null) {
      candidateReports.push({ path: candidate.path, source: candidate.source, exists: false, sessionDirCount: 0 })
      continue
    }
    const cross = crossValidate(scan, knownIds)
    const exactCount = cross.matched.filter((m) => m.match === 'exact').length
    candidateReports.push({
      path: candidate.path,
      source: candidate.source,
      exists: true,
      sessionDirCount: scan.totalSessionDirs,
      exactMatches: exactCount,
      unmatchedKnownIds: cross.unmatchedKnownIds.length,
    })
    if (exactCount > 0 && (!best || exactCount > best.exactCount)) {
      best = { root: candidate.path, scan, cross, exactCount }
    }
  }

  if (!best) {
    const anyStructure = candidateReports.some((c) => c.exists && c.sessionDirCount > 0)
    return {
      status: 'unavailable',
      root: null,
      candidates: candidateReports,
      matched: [],
      unmatchedKnownIds: knownIds,
      warnings: anyStructure
        ? ['candidate-roots-have-structure-but-no-known-session-id-matched']
        : ['no-candidate-root-with-valid-structure'],
    }
  }

  const { root, cross, scan } = best
  if (cross.unmatchedKnownIds.length > 0) {
    warnings.push(`${cross.unmatchedKnownIds.length} known session id(s) not found on disk under the confirmed root`)
  }
  if (cross.normalizedMatches.length > 0) {
    warnings.push(`${cross.normalizedMatches.length} session(s) matched only after id-segment normalization; those are advisory and not deletable`)
  }
  const orphans = cross.orphanDirs.length
  if (orphans > 0) warnings.push(`${orphans} session directory(ies) on disk have no matching known session id`)

  return {
    status: 'confirmed',
    root,
    candidates: candidateReports,
    matched: cross.matched,
    unmatchedKnownIds: cross.unmatchedKnownIds,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 删除前瞬时复检
// ---------------------------------------------------------------------------

/**
 * 路径包含检查：target 必须严格位于 root 之内（或等于 root）。
 */
export function isPathInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!isAbsolute(rel) && !/^\.\.([\\/]|$)/.test(rel))
}

/**
 * 物理删除前的最后一道确认：目标目录必须满足——
 *   a. 位于已确认 root 内，且恰为 root/<projectDir>/<sessionDir> 两层深度；
 *   b. projectDir 段匹配项目目录命名（--...-- 或 _no-cwd）；
 *   c. sessionDir 段与发现阶段记录的目录名一致（防调包）；
 *   d. 目录内至少一个 session 日志文件，且没有子目录；
 *   e. sessionDir 名必须与目标会话 id 完全相等；归一匹配只作诊断，绝不授权删除。
 * 任一不满足 → 拒绝删除。本函数不做任何写操作。
 */
export async function assertDeletableSessionDir(root, matched, sessionId, fs = DEFAULT_FS) {
  const fail = (reason) => ({ ok: false, reason, path: matched?.path ?? null })
  if (!matched || typeof matched.path !== 'string') return fail('no-matched-directory')
  if (matched.match && matched.match !== 'exact') return fail('non-exact-match')
  if (!isPathInside(root, matched.path)) return fail('path-outside-root')

  const rel = relative(resolve(root), resolve(matched.path))
  if (!rel || isAbsolute(rel) || /^\.\.([\\/]|$)/.test(rel)) return fail('path-outside-root')
  const segments = rel.split(/[\\/]/).filter(Boolean)
  if (segments.length !== 2) return fail('unexpected-depth')
  const [projectDir, sessionDir] = segments
  if (projectDir !== NO_CWD_DIR && !PROJECT_DIR_RE.test(projectDir)) return fail('invalid-project-dir')
  if (matched.projectDir && matched.projectDir !== projectDir) return fail('project-dir-mismatch')
  if (matched.name && matched.name !== sessionDir) return fail('session-dir-mismatch')

  // e. 目录名必须与目标会话 id 完全一致（不做归一化授权）。
  if (sessionDir !== sessionId) return fail('session-dir-name-mismatch')

  const st = await safeStat(fs, matched.path)
  if (!st || !st.isDirectory) return fail('session-dir-missing')

  const entries = await safeReaddir(fs, matched.path, true)
  if (entries === null) return fail('session-dir-unreadable')
  const files = entries.filter((e) => e.isFile())
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length > 0) return fail('unexpected-subdirectory')
  const journals = files.filter((f) => SESSION_FILE_RE.test(f.name))
  if (journals.length === 0) return fail('no-journal-files')

  return { ok: true, reason: 'ok', path: matched.path, projectDir, sessionDir }
}

/**
 * 输出供 UI / 报告使用的体积汇总。
 */
export function summarizeMatched(matchedList) {
  const list = Array.isArray(matchedList) ? matchedList : []
  return {
    count: list.length,
    totalBytes: list.reduce((sum, m) => sum + (m.sizeBytes || 0), 0),
  }
}
