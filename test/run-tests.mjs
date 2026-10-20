/**
 * run-tests.mjs — Archived Session Cleaner 离线测试套件
 *
 * 覆盖：存储发现与确认、列表与筛选、预览、备份与下载、删除管线顺序、
 *      安全护栏（未确认/非归档/live/运行活动/无目录/子目录/批量上限/备份失败）、
 *      删除后验证、失败隔离、幂等。
 *
 * 运行：node test/run-tests.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { makeHarness, ULID } from './mock-harness.js'
import { assertDeletableSessionDir } from '../src/storage-discovery.js'
import { statsFromEvents, isEmptyStats, applyFilters } from '../src/enrich.js'
import { buildTarGz } from '../src/backup.js'

// ---- 隔离 HOME（插件把设置/备份写在 $DSH_HOME/archived-session-cleaner） ----
const TEST_HOME = await mkdtemp(join(tmpdir(), 'asc-home-'))
process.env.HOME = TEST_HOME
process.env.USERPROFILE = TEST_HOME
process.env.DSH_HOME = TEST_HOME

// ---- 迷你测试框架 ----
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const results = []
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

// ---------------------------------------------------------------------------
// 一、存储发现与结构确认
// ---------------------------------------------------------------------------

test('discovery: configured root is confirmed and matched', async () => {
  const h = await harnessWith({})
  try {
    const storage = await h.invoke('GET', '/dsh-asc/api/storage')
    eq(storage.status, 200)
    eq(storage.body.status, 'confirmed', 'storage status')
    eq(storage.body.root, h.root, 'confirmed root')
    eq(storage.body.matched.length, 5, 'matched sessions')
    assert(storage.body.matched.every((m) => m.match === 'exact'), 'all exact matches')
    eq(storage.body.warnings.length, 0, 'no warnings')
  } finally {
    await h.cleanup()
  }
})

test('discovery: no candidate with structure -> unavailable, delete blocked', async () => {
  const h = await makeHarness({ sessionRoot: '/nonexistent/asc-root-xyz' })
  try {
    const caps = await h.invoke('GET', '/dsh-asc/api/capabilities')
    eq(caps.body.storage.status, 'unavailable', 'status')
    eq(caps.body.canDelete, false, 'delete must be disabled')
    const del = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1)] })
    eq(del.body.aborted, 'storage-unconfirmed', 'delete aborted')
    eq(h.archivedIds().length, 4, 'archive set untouched')
    eq(h.workspaceSessionIds().length, 5, 'membership untouched')
  } finally {
    await h.cleanup()
  }
})

test('discovery: valid structure but zero known-id match -> unavailable', async () => {
  const h = await makeHarness({})
  try {
    // 另建一个有结构但没有已知 id 的 root
    const rogueRoot = join(h.base, 'rogue-root')
    await mkdir(join(rogueRoot, '--other--', 'unknown-session-id'), { recursive: true })
    await writeFile(join(rogueRoot, '--other--', 'unknown-session-id', 'session.v3.jsonl'), '{}\n', 'utf8')
    const h2 = await makeHarness({ sessionRoot: rogueRoot })
    try {
      const storage = await h2.invoke('GET', '/dsh-asc/api/storage')
      eq(storage.body.status, 'unavailable', 'rogue root must not be confirmed')
      assert(storage.body.warnings.some((w) => w.includes('no-known-session-id-matched')), 'warning recorded')
    } finally {
      await h2.cleanup()
    }
  } finally {
    await h.cleanup()
  }
})

test('discovery: env DSH_SESSION_ROOT is honored when config is empty', async () => {
  const h = await makeHarness({ sessionRoot: '' })
  try {
    process.env.DSH_SESSION_ROOT = h.root
    const storage = await h.invoke('GET', '/dsh-asc/api/storage')
    eq(storage.body.status, 'confirmed', 'env root confirmed')
    eq(storage.body.root, h.root, 'env root used')
  } finally {
    delete process.env.DSH_SESSION_ROOT
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 二、列表与筛选
// ---------------------------------------------------------------------------

test('sessions: archived list with enrichment', async () => {
  const h = await harnessWith({})
  try {
    const res = await h.invoke('GET', '/dsh-asc/api/sessions')
    eq(res.body.total, 4, 'archived count (1,2,3,5 archived; 4 active)')
    const byId = new Map(res.body.items.map((i) => [i.sessionId, i]))
    const s1 = byId.get(ULID(1))
    eq(s1.title, '旧版登录重构', 'title')
    eq(s1.origin, 'user', 'origin')
    assert(s1.createdAt > 0, 'createdAt')
    assert(s1.sizeBytes > 0, 'sizeBytes from disk')
    eq(s1.onDisk, true, 'onDisk')
    eq(s1.workspaceTitle, 'mock-project', 'workspace title')
    eq(s1.archivedAt, null, 'archive time not recorded by DSH')
    eq(s1.stats.userMessages, 12, 'user messages')
    assert(s1.stats.assistantMessages >= 1, 'assistant messages')
    const s2 = byId.get(ULID(2))
    eq(s2.empty, true, 'empty session flagged')
    const s3 = byId.get(ULID(3))
    eq(s3.origin, 'subagent', 'subagent origin')
    const s5 = byId.get(ULID(5))
    eq(s5.title, null, 'null title preserved')
    assert(!h.archivedIds().includes(ULID(4)), 'active session not listed')
  } finally {
    await h.cleanup()
  }
})

test('filters: keyword / empty / subagent / date range', async () => {
  const h = await harnessWith({})
  try {
    const kw = await h.invoke('GET', '/dsh-asc/api/sessions?keyword=' + encodeURIComponent('登录'))
    eq(kw.body.items.length, 1, 'keyword filter')
    eq(kw.body.items[0].sessionId, ULID(1), 'keyword hit')
    const empty = await h.invoke('GET', '/dsh-asc/api/sessions?empty=1')
    eq(empty.body.items.length, 1, 'empty filter')
    eq(empty.body.items[0].sessionId, ULID(2), 'empty hit')
    const sub = await h.invoke('GET', '/dsh-asc/api/sessions?subagent=1')
    eq(sub.body.items.length, 1, 'subagent filter')
    eq(sub.body.items[0].sessionId, ULID(3), 'subagent hit')
    const from = await h.invoke('GET', `/dsh-asc/api/sessions?from=${isoDay(-14)}`)
    const fromIds = from.body.items.map((i) => i.sessionId).sort()
    eq(fromIds.length, 2, 'from filter (14d) keeps 2')
    const to = await h.invoke('GET', `/dsh-asc/api/sessions?to=${isoDay(-14)}`)
    eq(to.body.items.length, 2, 'to filter (14d) keeps the two older ones')
    const toIds = to.body.items.map((i) => i.sessionId).sort()
    eq(toIds[0], ULID(1), 'to hit 1')
    eq(toIds[1], ULID(5), 'to hit 2')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 三、预览
// ---------------------------------------------------------------------------

test('preview: counts and warnings', async () => {
  const h = await harnessWith({})
  try {
    const ok = await h.invoke('POST', '/dsh-asc/api/preview', { ids: [ULID(1), ULID(2), ULID(3)] })
    eq(ok.body.count, 3, 'preview count')
    eq(ok.body.storageStatus, 'confirmed', 'storage status echoed')
    assert(ok.body.items.every((i) => i.archived && i.onDisk), 'all archived and on disk')
    assert(ok.body.totalBytes > 0, 'total bytes')
    const bad = await h.invoke('POST', '/dsh-asc/api/preview', { ids: [ULID(1), ULID(4)] })
    const s4 = bad.body.items.find((i) => i.sessionId === ULID(4))
    assert(s4.warnings.includes('not-archived'), 'not-archived warning')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 四、备份与下载
// ---------------------------------------------------------------------------

test('backup: export, list and tar.gz download', async () => {
  const h = await harnessWith({})
  try {
    const res = await h.invoke('POST', '/dsh-asc/api/backup', { ids: [ULID(1)] })
    eq(res.body.ok, true, 'backup ok')
    const backupId = res.body.backupId
    eq(res.body.files, 3, 'backup copies 3 files (2 journals + lock)')
    const list = await h.invoke('GET', '/dsh-asc/api/backups')
    assert(list.body.items.some((b) => b.backupId === backupId), 'backup listed')
    const dl = await h.invoke('GET', `/dsh-asc/api/backup/${backupId}/download`)
    eq(dl.status, 200, 'download status')
    eq(dl.headers['content-type'], 'application/gzip', 'gzip content type')
    const raw = await fetchBackupBytes(h, backupId)
    const listing = tarEntryNames(raw)
    assert(listing.includes('manifest.json'), 'tar contains manifest')
    const seg = listing.find((name) => name.includes('session.jsonl') && name.includes(ULID(1).slice(0, 8)))
    assert(seg, 'tar contains session journals')
    assert(listing.some((name) => name.endsWith('/session.v3.jsonl')), 'tar contains current generation')
    // 头部声明长度为实际 gzip 字节，防止下载截断
    eq(Number(dl.headers['content-length']), raw.length, 'content-length matches body')
  } finally {
    await h.cleanup()
  }
})

test('backup: delete removes one backup and validates its id', async () => {
  const h = await harnessWith({})
  try {
    const created = await h.invoke('POST', '/dsh-asc/api/backup', { ids: [ULID(1)] })
    eq(created.body.ok, true, 'backup created')
    const backupId = created.body.backupId

    const removed = await h.invoke('POST', '/dsh-asc/api/backups/delete', { backupId })
    eq(removed.status, 200, 'delete status')
    eq(removed.body.ok, true, 'delete ok')
    const list = await h.invoke('GET', '/dsh-asc/api/backups')
    assert(!list.body.items.some((b) => b.backupId === backupId), 'backup no longer listed')

    const again = await h.invoke('POST', '/dsh-asc/api/backups/delete', { backupId })
    eq(again.status, 404, 'second delete is not found')

    for (const bad of ['../outside', '..%5Coutside', 'a.b']) {
      const res = await h.invoke('POST', '/dsh-asc/api/backups/delete', { backupId: bad })
      eq(res.status, 400, `invalid backup id rejected: ${bad}`)
    }
  } finally {
    await h.cleanup()
  }
})

test('backup download rejects traversal-shaped ids', async () => {
  const h = await harnessWith({})
  try {
    for (const id of ['..%5C..%5Csecret', '..%2F..%2Fsecret', '....', 'a.b']) {
      const res = await h.invoke('GET', `/dsh-asc/api/backup/${id}/download`)
      eq(res.status, 404, `traversal id rejected: ${id}`)
    }
  } finally {
    await h.cleanup()
  }
})

test('verifyBackupDir detects corruption', async () => {
  const h = await harnessWith({})
  try {
    const res = await h.invoke('POST', '/dsh-asc/api/backup', { ids: [ULID(2)] })
    eq(res.body.ok, true, 'backup ok')
    const dir = res.body.dir
    // 等长破坏副本（保证 size 一致、sha 不一致）后调用内部校验
    const { verifyBackupDir } = await import('../src/backup.js')
    const { readFile: rf } = await import('node:fs/promises')
    const manifest = JSON.parse(await rf(join(dir, 'manifest.json'), 'utf8'))
    const victim = join(dir, manifest.items[0].relativePath, 'session.v3.jsonl')
    const len = (await rf(victim)).length
    await writeFile(victim, 'x'.repeat(len), 'utf8')
    const v = await verifyBackupDir(dir, manifest)
    eq(v.ok, false, 'corruption detected')
    assert(v.reason.includes('sha256-mismatch'), 'sha mismatch reported')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 五、删除：happy path + 验证 + 幂等
// ---------------------------------------------------------------------------

test('delete: happy path cleans archive set, membership and disk; verification passes', async () => {
  const h = await harnessWith({})
  try {
    const res = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1), ULID(2), ULID(3)] })
    eq(res.body.aborted, null, 'not aborted')
    eq(res.body.summary.deleted, 3, 'deleted count')
    eq(res.body.summary.failed, 0, 'failed count')
    eq(res.body.summary.skipped, 0, 'skipped count')
    assert(res.body.backup && res.body.backup.ok === true, 'inline backup ok')
    eq(h.unarchiveCalls.length, 3, 'unarchiveSession called per id')
    eq(h.archivedIds().length, 1, 'archive set cleared (only ULID(5) remains)')
    eq(h.archivedIds()[0], ULID(5), 'remaining archived id')
    const wsIds = h.workspaceSessionIds()
    for (const i of [1, 2, 3]) assert(!wsIds.includes(ULID(i)), `membership cleared for ${i}`)
    assert(wsIds.includes(ULID(4)) && wsIds.includes(ULID(5)), 'other sessions untouched')
    for (const i of [1, 2, 3]) {
      eq(await h.persistence.stat(ULID(i)), undefined, `disk dir removed for ${i}`)
    }
    const d = res.body.deleted[0]
    eq(d.verification.archiveCleared, true, 'verified: archive cleared')
    eq(d.verification.membershipsCleared, true, 'verified: membership cleared')
    eq(d.verification.persistenceCleared, true, 'verified: persistence cleared')
    eq(d.verification.diskCleared, true, 'verified: disk cleared')
    const list = await h.invoke('GET', '/dsh-asc/api/sessions')
    eq(list.body.total, 1, 'session list has only ULID(5) after delete')
    // 幂等：再次删除同一 id
    const again = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1)] })
    eq(again.body.aborted, 'nothing-runnable', 'second delete aborts')
    eq(again.body.skipped[0].reason, 'not-archived', 'second delete skipped as not-archived')
  } finally {
    await h.cleanup()
  }
})

test('delete: guard rejects live, unarchived, no-dir, subdir and oversized batches', async () => {
  const h = await harnessWith({
    sessions: [
      { idx: 1, archived: true, daysAgo: 30, userMsgs: 5 },
      { idx: 4, archived: false, live: true, daysAgo: 1, userMsgs: 3 },
      { idx: 6, archived: true, noDir: true, daysAgo: 3, userMsgs: 2 },
      { idx: 7, archived: true, withSubdir: true, daysAgo: 4, userMsgs: 2 },
    ],
  })
  try {
    // 非归档（活跃会话）→ skipped
    const r1 = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(4)] })
    eq(r1.body.skipped[0].reason, 'not-archived', 'not-archived skipped')
    // live 会话（先手工归档它）→ skipped
    h.registryState.archivedSessionIds.push(ULID(4))
    const r2 = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(4)] })
    eq(r2.body.skipped[0].reason, 'live-session', 'live skipped')
    assert(h.archivedIds().includes(ULID(4)), 'live session remains archived (untouched)')
    // 无磁盘目录 → skipped
    const r3 = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(6)] })
    eq(r3.body.skipped[0].reason, 'no-confirmed-directory', 'no-dir skipped')
    // 目录内含子目录 → 备份后、删除前复检失败；但会话应恢复可见、数据完好
    const r4 = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(7)] })
    eq(r4.body.failed.length, 1, 'one failure')
    eq(r4.body.failed[0].stage, 'pre-delete-check', 'stage')
    eq(r4.body.failed[0].reason, 'unexpected-subdirectory', 'reason')
    assert(!h.archivedIds().includes(ULID(7)), 'failed item un-archived (safe: visible again)')
    assert(!h.workspaceSessionIds().includes(ULID(7)), 'failed item detached (ungrouped)')
    const st = await h.persistence.stat(ULID(7))
    assert(st, 'failed item data intact on disk')
    // 批量上限
    const many = Array.from({ length: 51 }, (_, i) => `01HBIG${String(i).padStart(24, '0')}`)
    const r5 = await h.invoke('POST', '/dsh-asc/api/delete', { ids: many })
    eq(r5.body.aborted, 'batch-too-large', 'oversized batch aborted')
    eq(r5.body.requested, 51, 'aborted report carries requested count')
    eq(r5.body.maxBatch, 50, 'aborted report carries maxBatch')
  } finally {
    await h.cleanup()
  }
})

test('delete: running activity blocks unless forced', async () => {
  const h = await harnessWith({ activities: { [ULID(1)]: [{ kind: 'turn' }] } })
  try {
    const r = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1), ULID(2)] })
    eq(r.body.summary.deleted, 1, 'non-active session deleted')
    eq(r.body.skipped[0].reason, 'session-active', 'active session skipped')
    eq(r.body.skipped[0].sessionId, ULID(1), 'skipped is the active one')
    const rf = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1)], force: true })
    eq(rf.body.summary.deleted, 1, 'force overrides activity probe')
  } finally {
    await h.cleanup()
  }
})

test('delete: backup failure aborts everything and mutates nothing', async () => {
  const h = await harnessWith({})
  // 让插件数据目录成为文件 → 备份目录无法创建 → backup-failed
  const dataDir = join(TEST_HOME, 'archived-session-cleaner')
  await rm(dataDir, { recursive: true, force: true })
  await writeFile(dataDir, 'not-a-directory', 'utf8')
  try {
    const r = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1), ULID(2)] })
    eq(r.body.aborted, 'backup-failed', 'aborted on backup failure')
    eq(r.body.deleted.length, 0, 'nothing deleted')
    eq(h.archivedIds().length, 4, 'archive set untouched')
    eq(h.workspaceSessionIds().length, 5, 'membership untouched')
    assert(await h.persistence.stat(ULID(1)), 'data intact')
    eq(h.unarchiveCalls.length, 0, 'registry never touched')
  } finally {
    await rm(dataDir, { force: true })
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 六、设置驱动的存储修复路径
// ---------------------------------------------------------------------------

test('settings: explicit sessionRoot rescues an unconfirmed deployment', async () => {
  const h = await makeHarness({ sessionRoot: '' })
  try {
    const before = await h.invoke('GET', '/dsh-asc/api/capabilities')
    eq(before.body.storage.status, 'unavailable', 'initially unavailable')
    const del0 = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1)] })
    eq(del0.body.aborted, 'storage-unconfirmed', 'delete blocked')
    const saved = await h.invoke('POST', '/dsh-asc/api/settings', { sessionRoot: h.root })
    eq(saved.body.sessionRoot, h.root, 'settings echoed')
    const after = await h.invoke('GET', '/dsh-asc/api/capabilities')
    eq(after.body.storage.status, 'confirmed', 'storage confirmed after fix')
    eq(after.body.canDelete, true, 'delete enabled')
    const del = await h.invoke('POST', '/dsh-asc/api/delete', { ids: [ULID(1)] })
    eq(del.body.summary.deleted, 1, 'delete now works')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 六之二、失效归档记录清理
// ---------------------------------------------------------------------------

test('maintenance: orphaned archived ids are pruned without touching valid ones', async () => {
  const h = await harnessWith({})
  try {
    const ghost = '01HGHOST00000000000000000000'
    h.registryState.archivedSessionIds.push(ghost)
    const before = h.archivedIds().length
    const res = await h.invoke('POST', '/dsh-asc/api/prune-orphans', {})
    eq(res.status, 200, 'prune status')
    eq(res.body.ok, true, 'prune ok')
    eq(res.body.pruned, 1, 'one orphan pruned')
    assert(!h.archivedIds().includes(ghost), 'ghost archive id removed')
    eq(h.archivedIds().length, before - 1, 'valid archive ids retained')
    const second = await h.invoke('POST', '/dsh-asc/api/prune-orphans', {})
    eq(second.body.pruned, 0, 'prune is idempotent')
  } finally {
    await h.cleanup()
  }
})

test('maintenance: prune refuses to run while storage is unconfirmed', async () => {
  const h = await makeHarness({ sessionRoot: '/nonexistent/asc-prune-root' })
  try {
    const ghost = '01HGHOST00000000000000000001'
    h.registryState.archivedSessionIds.push(ghost)
    const res = await h.invoke('POST', '/dsh-asc/api/prune-orphans', {})
    eq(res.body.ok, false, 'prune refused')
    eq(res.body.reason, 'storage-unconfirmed', 'reason reported')
    assert(h.archivedIds().includes(ghost), 'archive set untouched')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 七、纯函数单测
// ---------------------------------------------------------------------------

test('unit: assertDeletableSessionDir rejections', async () => {
  const h = await harnessWith({})
  try {
    const s1dir = join(h.root, '--mock-project--', ULID(1))
    const good = { sessionId: ULID(1), projectDir: '--mock-project--', name: ULID(1), path: s1dir }
    eq((await assertDeletableSessionDir(h.root, good, ULID(1))).ok, true, 'good dir passes')
    const traversal = { sessionId: ULID(1), projectDir: '--mock-project--', name: ULID(1), path: join(h.base, 'outside', ULID(1)) }
    eq((await assertDeletableSessionDir(h.root, traversal, ULID(1))).ok, false, 'outside root rejected')
    const wrongName = { sessionId: ULID(1), projectDir: '--mock-project--', name: ULID(2), path: s1dir }
    eq((await assertDeletableSessionDir(h.root, wrongName, ULID(1))).reason, 'session-dir-mismatch', 'mismatched name rejected')
    const deep = { sessionId: ULID(1), projectDir: '--mock-project--', name: ULID(1), path: join(h.root, '--mock-project--', ULID(1), 'session.v3.jsonl') }
    eq((await assertDeletableSessionDir(h.root, deep, ULID(1))).reason, 'unexpected-depth', 'file path rejected')
    const empty = join(h.base, '--x--', 'x')
    await mkdir(empty, { recursive: true })
    const emptyMatch = { sessionId: 'x', projectDir: '--x--', name: 'x', path: empty }
    eq((await assertDeletableSessionDir(h.base, emptyMatch, 'x')).reason, 'no-journal-files', 'empty dir rejected')
    // 归一匹配只作诊断：即使目录名归一后等于 id，也绝不授权删除。
    const normalized = {
      sessionId: ULID(1), projectDir: '--mock-project--', name: ULID(1).replace(/-/g, '_'),
      path: s1dir, match: 'normalized',
    }
    eq((await assertDeletableSessionDir(h.root, normalized, ULID(1))).reason, 'non-exact-match', 'normalized-only match rejected')
  } finally {
    await h.cleanup()
  }
})

test('unit: Config standard schema applies defaults and clamps maxBatch', async () => {
  const { Config } = await import('../src/index.js')
  const validate = Config['~standard'].validate
  eq(typeof validate, 'function', 'Config exposes ~standard.validate')
  const defaults = validate({})
  eq(defaults.value.requireBackup, true, 'backup defaults on')
  eq(defaults.value.sessionRoot, '', 'root defaults empty')
  eq(defaults.value.maxBatch, 50, 'batch defaults 50')
  eq(validate({ requireBackup: false, maxBatch: 500 }).value.maxBatch, 200, 'maxBatch clamped')
  eq(validate({ maxBatch: 0 }).value.maxBatch, 1, 'maxBatch lower-bounded')
  assert(validate('nope').issues, 'non-object config is rejected')
})

test('unit: stats and filters', async () => {
  const events = [
    { time: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'a' }] } },
    {
      time: 2,
      type: 'assistant/message',
      data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, stream: [] },
    },
    {
      time: 3,
      type: 'tool/result',
      data: { turn: 0, step: 0, message: { role: 'tool', content: [{ type: 'tool-call' }] } },
    },
  ]
  const stats = statsFromEvents(events)
  eq(stats.userMessages, 1, 'user count')
  eq(stats.assistantMessages, 1, 'assistant count')
  eq(stats.toolCalls, 1, 'tool count')
  eq(stats.lastActivityAt, 3, 'last activity')
  eq(isEmptyStats(stats), false, 'not empty')
  eq(isEmptyStats({ userMessages: 0, assistantMessages: 0, toolCalls: 0 }), true, 'empty')
  eq(isEmptyStats(null), false, 'null not empty')
  const jan1 = Date.UTC(2026, 0, 1)
  const feb1 = Date.UTC(2026, 1, 1)
  const items = [
    { sessionId: 'a', title: '登录', origin: 'user', empty: true, createdAt: jan1, stats: { lastActivityAt: jan1 + 3600000 } },
    { sessionId: 'b', title: '其他', origin: 'subagent', empty: false, createdAt: feb1, stats: { lastActivityAt: feb1 + 3600000 } },
  ]
  eq(applyFilters(items, { keyword: '录' }).length, 1, 'keyword')
  eq(applyFilters(items, { emptyOnly: true })[0].sessionId, 'a', 'emptyOnly')
  eq(applyFilters(items, { subagentOnly: true })[0].sessionId, 'b', 'subagentOnly')
  eq(applyFilters(items, { from: '2026-01-15' }).length, 1, 'from')
  eq(applyFilters(items, { from: '2026-01-15' })[0].sessionId, 'b', 'from hit')
  eq(applyFilters(items, { to: '2026-01-15' }).length, 1, 'to')
  eq(applyFilters(items, { to: '2026-01-15' })[0].sessionId, 'a', 'to hit (end-of-day inclusive)')
  eq(applyFilters(items, { timeField: 'lastActivity', to: '2026-01-15' })[0].sessionId, 'a', 'lastActivity field')
})

test('client: registers through __ModuleLoader__ into sidebar and main', async () => {
  let definition
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  try {
    await import('../src/client.js?module-loader-test=' + Date.now())
    assert(definition, 'window.__ModuleLoader__.load was called')
    eq(definition.id, 'dsh-archived-session-cleaner', 'loader id equals package name')

    // Minimal hook host. State order: 0 = locale revision (useTranslate),
    // 1 = tab, 2 = loading, 3 = error, 4 = items, 5 = storage,
    // 6 = capabilities, 7 = settings, 10 = selected, 13 = modal, 14 = backups.
    const sampleItem = {
      sessionId: '01HSAMPLE', title: 'Sample session', createdAt: Date.now(),
      empty: false, origin: 'user', live: false, onDisk: true, sizeBytes: 2048,
      stats: { userMessages: 2, assistantMessages: 1, lastActivityAt: Date.now() },
    }
    let overrides = new Map()
    let stateIndex = 0
    const React = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (initial) => {
        const index = stateIndex
        stateIndex += 1
        const fallback = typeof initial === 'function' ? initial() : initial
        return [overrides.has(index) ? overrides.get(index) : fallback, () => {}]
      },
      useEffect: () => {},
      useRef: (initial) => ({ current: initial }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    }
    const plugin = definition.factory((specifier) => {
      eq(specifier, 'react', 'factory only requires react')
      return React
    })
    eq(plugin.name, 'dsh-archived-session-cleaner', 'client plugin name')
    assert(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), 'client injects slots')
    assert(plugin.inject.includes('locale'), 'client injects locale')
    eq(typeof plugin.apply, 'function', 'client plugin apply')

    const registered = []
    const injectedKeys = []
    let currentSlot = null
    const locale = {
      register: () => () => {},
      bind: () => (key) => key,
      getLocale: () => ({ active: 'zh-CN' }),
      subscribe: () => () => {},
    }
    const workspaces = { unarchiveSession: async () => {} }
    const ctx = {
      get: (name) => (name === 'locale' ? locale : name === 'workspaces' ? workspaces : undefined),
      effect: (callback) => {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      slots: {
        inject: (key, callback) => {
          injectedKeys.push(key)
          currentSlot = key
          callback()
        },
        register: (options, component) => {
          registered.push({ slot: currentSlot, options, component })
          return () => {}
        },
      },
    }
    plugin.apply(ctx)
    eq(injectedKeys.join(','), 'sidebar.panellist,main', 'sidebar panel and main page injected')
    eq(registered.length, 2, 'two slot registrations')

    const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist')
    const main = registered.find((entry) => entry.options.name === 'main')
    assert(sidebar, 'sidebar panel registration')
    assert(main, 'main page registration')
    eq(sidebar.options.id, 'archived-session-cleaner', 'sidebar panel id')
    eq(main.options.key, 'archived-session-cleaner', 'main page key')
    eq(typeof sidebar.options.label, 'function', 'sidebar label is localized lazily')
    eq(typeof sidebar.component, 'function', 'panel icon component')
    eq(typeof main.component, 'function', 'page component')

    const icon = sidebar.component({ size: 20, active: true })
    eq(icon.type, 'svg', 'panel icon renders svg')
    eq(icon.props.width, 20, 'panel icon honors size')

    function renderWith(nextOverrides) {
      overrides = new Map(nextOverrides)
      stateIndex = 0
      return textOf(main.component())
    }

    const listText = renderWith([
      [2, false], [4, [sampleItem]], [5, { status: 'confirmed', root: 'C:/logs', warnings: [] }],
      [10, new Set(['01HSAMPLE'])],
    ])
    assert(listText.includes('归档会话清理器'), 'page title renders in Chinese')
    assert(listText.includes('Sample session'), 'session row renders')
    assert(listText.includes('存储已确认'), 'storage tag renders')
    assert(listText.includes('导出备份'), 'bulk actions render')

    const settingsText = renderWith([
      [1, 'settings'],
      [6, { services: { workspaceRegistry: true, sessionQuery: true, persistenceStat: true } }],
    ])
    assert(settingsText.includes('会话日志根目录'), 'settings tab renders')
    assert(settingsText.includes('宿主能力'), 'capability summary renders')
    assert(settingsText.includes('删除前强制备份'), 'backup switch renders')
    assert(settingsText.includes('清理失效记录'), 'manual orphan cleanup action renders')

    const backupsText = renderWith([
      [1, 'backups'], [15, false], [17, true],
      [14, [{ backupId: 'b1', createdAt: Date.now(), sessionCount: 1, bytes: 2048 }]],
    ])
    assert(backupsText.includes('b1'), 'backup row renders')
    assert(backupsText.includes('下载'), 'backup download action renders')
    assert(backupsText.includes('删除'), 'backup delete action renders')

    const backupUnavailableText = renderWith([
      [1, 'backups'], [15, false], [17, false],
      [14, [{ backupId: 'b1', createdAt: Date.now(), sessionCount: 1, bytes: 2048 }]],
    ])
    assert(backupUnavailableText.includes('重启一次'), 'unavailable delete route is explained')

    const backupDeleteText = renderWith([
      [13, {
        kind: 'backup-delete',
        backup: { backupId: 'b1', createdAt: Date.now(), sessionCount: 1, bytes: 2048 },
      }],
    ])
    assert(backupDeleteText.includes('删除备份'), 'backup delete dialog renders')
    assert(backupDeleteText.includes('删除后无法恢复'), 'backup delete warning renders')

    const confirmText = renderWith([
      [4, [sampleItem]],
      [13, { kind: 'confirm', count: 1, bytes: 2048, checked: true, typed: 'DELETE' }],
    ])
    assert(confirmText.includes('确认删除'), 'confirm dialog renders')
    assert(!confirmText.includes('删除前预览'), 'preview page is gone')
    assert(!confirmText.includes('01HSAMPLE'), 'confirm dialog does not list per-session rows')

    const reportText = renderWith([
      [13, {
        kind: 'report',
        report: {
          deleted: [{ sessionId: '01HSAMPLE' }],
          failed: [{ sessionId: '01HBAD', stage: 'verify', message: 'disk still present' }],
          skipped: [{ sessionId: '01HSKIP', reason: 'live-session' }],
          backup: { ok: true, backupId: 'b1', bytes: 2048 },
          warnings: [],
        },
      }],
    ])
    assert(reportText.includes('删除报告'), 'report dialog renders')
    assert(reportText.includes('01HBAD'), 'failed row renders')
    assert(reportText.includes('01HSKIP'), 'skipped row renders')

    const untitledText = renderWith([
      [2, false],
      [4, [{ ...sampleItem, title: null, createdAt: null }]],
      [5, { status: 'confirmed', root: 'C:/logs', warnings: [] }],
    ])
    assert(untitledText.includes('未命名会话'), 'untitled session gets a label')
    assert(!untitledText.includes('创建 -'), 'missing createdAt is omitted')

    const liveText = renderWith([
      [2, false],
      [4, [{ ...sampleItem, live: true }]],
      [5, { status: 'confirmed', root: 'C:/logs', warnings: [] }],
      [10, new Set(['01HSAMPLE'])],
    ])
    assert(liveText.includes('运行中的会话不能删除'), 'live selection is blocked with an explanation')
    assert(liveText.includes('移出归档'), 'live row offers an unarchive escape hatch')

    const overLimitText = renderWith([
      [2, false], [4, [sampleItem]],
      [5, { status: 'confirmed', root: 'C:/logs', warnings: [] }],
      [10, new Set(Array.from({ length: 62 }, (_, i) => `id-${i}`))],
    ])
    assert(overLimitText.includes('超过单批上限'), 'over-limit selection is explained')

    const orphanText = renderWith([
      [2, false],
      [4, [{ ...sampleItem, onDisk: false, persisted: false, live: false }]],
      [5, { status: 'confirmed', root: 'C:/logs', warnings: [] }],
      [6, { services: { sessionQuery: true, persistenceList: true } }],
    ])
    assert(orphanText.includes('发现已删除但仍保留归档标记的会话'), 'orphan notice renders')
    assert(orphanText.includes('清理失效记录'), 'orphan cleanup action renders')

    const abortedText = renderWith([
      [13, {
        kind: 'report',
        report: {
          aborted: 'batch-too-large', requested: 62, maxBatch: 50,
          deleted: [], failed: [], skipped: [], warnings: [],
        },
      }],
    ])
    assert(abortedText.includes('62 / 50'), 'aborted report shows the limit')
    assert(abortedText.includes('未执行删除'), 'aborted report is localized')
    assert(!abortedText.includes('部分失败'), 'aborted report does not claim partial failure')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }

  const built = await (await import('node:fs/promises')).readFile(join(h_dir(), 'lib', 'client.js'), 'utf8')
  assert(built.includes('window.__ModuleLoader__.load('), 'built bundle registers a loader factory')
  assert(!/^\s*(import|export)\s/m.test(built), 'built bundle is a classic script')
  assert(!/from\s+['"]node:/.test(built), 'built bundle has no node imports')
})

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

function h_dir() {
  return join(process.cwd())
}

/** 先自建会话日志 root，再以其为 sessionRoot 创建 harness（避免循环依赖）。 */
async function harnessWith(opts = {}) {
  const rootBase = await mkdtemp(join(tmpdir(), 'asc-root-'))
  const root = join(rootBase, 'session-logs')
  const h = await makeHarness({ ...opts, root, sessionRoot: opts.sessionRoot ?? root })
  const origCleanup = h.cleanup.bind(h)
  h.cleanup = async () => {
    await origCleanup()
    await rm(rootBase, { recursive: true, force: true })
  }
  return h
}

function isoDay(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 24 * 3600 * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 取二进制响应体（gzip）。 */
async function fetchBackupBytes(h, backupId) {
  const res = await h.invoke('GET', `/dsh-asc/api/backup/${backupId}/download`)
  if (res.raw && res.status === 200) return res.raw
  throw new Error('download failed: HTTP ' + res.status)
}

/** Minimal ustar reader: returns entry names from a gzip-compressed tar. */
function tarEntryNames(gz) {
  const buf = gunzipSync(gz)
  const names = []
  let offset = 0
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0
    if (name) names.push(name)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

// ---- 运行器 ----
let passed = 0
const failures = []
for (const t of tests) {
  try {
    await t.fn()
    passed += 1
    console.log(`PASS  ${t.name}`)
  } catch (e) {
    failures.push({ name: t.name, error: e })
    console.log(`FAIL  ${t.name}\n      ${e.message}`)
  }
}
await rm(TEST_HOME, { recursive: true, force: true })
console.log(`\n${passed}/${tests.length} passed`)
if (failures.length > 0) process.exitCode = 1
