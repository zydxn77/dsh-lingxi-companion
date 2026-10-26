/**
 * 冒烟测试：拿桩件顶替 DSH 的 sessionController，把 apply() 真跑一遍。
 *
 *   node tests/smoke-dsh-stub.mjs
 *
 * 自己建临时 DSH_HOME 和临时工作区（不碰真账本、不扫真会话目录）。
 *
 * 融合之后投递目标变了：**不再开新会话，说话进他正开着的那个会话**。
 * 所以 A 场景先造一个「主会话」（header 里 delegationDepth: 0），
 * 再验证插件把话插进去、而不是 create 一个新的。
 *
 *   A  正常        → 说进主会话、不建新会话、记账
 *   A2 子 agent    → delegationDepth > 0 的会话不该被当成主会话
 *   B  他正在用    → 不打断，这一趟往后挪
 *   C1 失败一次    → 记一次数，不前进
 *   C2 失败到上限  → 熔断，当天这一趟放弃
 *   D  心情落盘    → .lingxi/mood.json 写出来了
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = path.join(os.tmpdir(), 'lingxi-smoke-' + process.pid)
fs.rmSync(ROOT, { recursive: true, force: true })
const WORKSPACE = path.join(ROOT, 'ws')
const DSH = path.join(ROOT, 'dsh')
const SESSIONS = path.join(DSH, 'sessions')
fs.mkdirSync(WORKSPACE, { recursive: true })
fs.mkdirSync(SESSIONS, { recursive: true })

process.env.LINGXI_WORKSPACE = WORKSPACE
process.env.DSH_HOME = DSH

const { PATHS, localDateKey, writeState, readState, readJson } = await import('../lib/home.js')
const { apply } = await import('../lib/index.js')
const { findMainSession } = await import('../lib/spine.js')
const { MAX_FAILS_PER_SLOT } = await import('../lib/const.js')

const problems = []
const check = (cond, msg) => {
  if (!cond) problems.push(msg)
}

const SESSION_FILE = 'session.v4.jsonl.zstd'

/** 造一个会话：header 是第一帧，插件正是靠它认主会话 */
function makeSession({ id, depth = 0, dirName = null, ageMs = 0 }) {
  const dir = path.join(SESSIONS, '--ws--', dirName || id)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, SESSION_FILE)
  const header = JSON.stringify({ type: 'session', version: 4, id, cwd: WORKSPACE, delegationDepth: depth })
  fs.writeFileSync(f, zlib.zstdCompressSync(Buffer.from(header + '\n', 'utf8')))
  if (ageMs) {
    const t = new Date(Date.now() - ageMs)
    fs.utimesSync(f, t, t)
  }
  return f
}

function makeCtx(overrides = {}) {
  const rec = { created: [], renamed: [], sent: [], cleanups: [] }
  const ctx = {
    sessionController: {
      async create(arg) {
        rec.created.push(arg)
        return { sessionId: arg.sessionId }
      },
      async rename(arg) {
        rec.renamed.push(arg)
        return { title: arg.title }
      },
      async prompt(req, signal) {
        if (signal?.aborted) throw new Error('aborted')
        rec.sent.push(req)
        return { accepted: true }
      },
    },
    effect(fn) {
      rec.cleanups.push(fn())
    },
    ...overrides,
  }
  return { ctx, rec }
}

const failCtrl = (rec) => ({
  async create(arg) {
    rec.created.push(arg)
    return { sessionId: arg.sessionId }
  },
  async rename() {},
  async prompt() {
    const e = new Error('prompt rejected')
    e.code = 'session/agent-busy'
    throw e
  },
})

/** 把所有会话文件的 mtime 拨旧 —— 让「他正在用」闸不触发 */
function ageAll(ms = 3600_000) {
  for (const dir of fs.readdirSync(path.join(SESSIONS, '--ws--'))) {
    const f = path.join(SESSIONS, '--ws--', dir, SESSION_FILE)
    if (!fs.existsSync(f)) continue
    const t = new Date(Date.now() - ms)
    fs.utimesSync(f, t, t)
  }
}

const today = () => localDateKey(new Date())
const seedPlan = (over = {}) => ({
  key: today(),
  skip: false,
  times: [Date.now() - 1000, Date.now() + 3_600_000, Date.now() + 7_200_000],
  done: 0,
  fails: 0,
  deferSlot: null,
  deferSince: null,
  ...over,
})
const settle = () => new Promise((r) => setTimeout(r, 700))
const stopAll = (rec) => rec.cleanups.forEach((c) => c?.())

/* ───────── 认主会话：子 agent 的会话要排掉 ───────── */
console.log('\n── A0 认主会话 ──')
{
  makeSession({ id: 'session-sub', depth: 2, ageMs: 0 }) // 更新的子 agent 会话
  const main = makeSession({ id: 'session-main', depth: 0, ageMs: 60_000 })
  const hit = findMainSession(SESSIONS, 'lingxi')
  check(!!hit, 'A0 应该认出一个主会话')
  check(hit?.sessionId === 'session-main', `A0 主会话认错了：${hit?.sessionId}（子 agent 的不能被选中）`)
  check(fs.existsSync(main), 'A0 主会话文件应存在')
  console.log('  认出 :', hit?.sessionId)
}

/* ─────────────── A 正常一趟 ─────────────── */
console.log('\n── A 正常一趟 ──')
{
  ageAll() // 会话拨旧，免得「他正在用」闸把这一趟压住
  writeState({ plan: seedPlan() })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()

  check(rec.created.length === 0, `A 不该再建新会话，实际建了 ${rec.created.length}`)
  check(rec.renamed.length === 0, `A 不该再 rename，实际 ${rec.renamed.length}`)
  check(rec.sent.length === 1, `A 应该说 1 次话，实际 ${rec.sent.length}`)

  const r = rec.sent[0]
  if (r) {
    check(r.sessionId === 'session-main', `A 说话的对象应是主会话，实际 ${r.sessionId}`)
    check(r.mode === 'queue', `A mode 应为 queue，实际 ${r.mode}`)
    check(typeof r.requestId === 'string' && !!r.requestId, 'A 缺 requestId')
    check(r.requestId === `lingxi-${today()}-1`, `A requestId 形状不对：${r.requestId}`)
    check(r.content?.[0]?.type === 'text', 'A content[0].type 应为 text')
  }

  const st = readState()
  check(st.plan?.done === 1, `A 记账 done 应为 1，实际 ${st.plan?.done}`)
  check(st.plan?.lastSessionId === 'session-main', `A 记账 lastSessionId 不对：${st.plan?.lastSessionId}`)
  check(Number.isFinite(st.selfQuietUntil), 'A 应该记下 selfQuietUntil（那段窗口里 mtime 变新算她自己动的）')
  check(st.selfQuietUntil > Date.now(), 'A selfQuietUntil 应该在未来')

  console.log('  说进 :', r?.sessionId)
  console.log('  记账 :', JSON.stringify(st.plan))
  if (r) {
    const text = r.content[0].text
    console.log('  提示头:', JSON.stringify(text.split('\n')[0].slice(0, 40)), `(${text.length} 字)`)
  }
  stopAll(rec)
}

/* ─────────────── B 他正在用，别打断 ─────────────── */
console.log('\n── B 他正在用 ──')
{
  // 主会话刚被动过 → 他正在说话
  const f = path.join(SESSIONS, '--ws--', 'session-main', SESSION_FILE)
  fs.utimesSync(f, new Date(), new Date())
  writeState({ plan: seedPlan(), heardAt: Date.now() - 30 * 60_000, selfQuietUntil: 0 })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()

  check(rec.sent.length === 0, `B 不该插话，实际插了 ${rec.sent.length}`)
  const st = readState()
  check(Number.isFinite(st.plan?.deferSince), 'B 应该记下 deferSince')
  check(st.plan?.done === 0, `B done 不该前进，实际 ${st.plan?.done}`)
  console.log('  记账 :', JSON.stringify(st.plan))
  stopAll(rec)
}

/* ─────────── C1 失败一次记一次 ─────────── */
console.log('\n── C1 失败一次记一次 ──')
{
  const f = path.join(SESSIONS, '--ws--', 'session-main', SESSION_FILE)
  fs.utimesSync(f, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000))
  writeState({ plan: seedPlan() })
  const { ctx, rec } = makeCtx()
  ctx.sessionController = failCtrl(rec)
  apply(ctx, {})
  await settle()

  const st = readState()
  check(st.plan?.fails === 1, `C1 fails 应为 1，实际 ${st.plan?.fails}`)
  check(st.plan?.done === 0, `C1 done 不该前进，实际 ${st.plan?.done}`)
  console.log('  记账 :', JSON.stringify(st.plan))
  stopAll(rec)
}

/* ─────────── C2 熔断 ─────────── */
console.log('\n── C2 连续失败到上限就熔断 ──')
{
  ageAll()
  writeState({ plan: seedPlan({ fails: MAX_FAILS_PER_SLOT - 1 }) })
  const { ctx, rec } = makeCtx()
  ctx.sessionController = failCtrl(rec)
  apply(ctx, {})
  await settle()

  const st = readState()
  check(st.plan?.done === 1, `C2 熔断后 done 应前进到 1，实际 ${st.plan?.done}`)
  check(st.plan?.fails === 0, `C2 熔断后 fails 应清零，实际 ${st.plan?.fails}`)
  check(Array.isArray(st.plan?.burned) && st.plan.burned.includes(1), 'C2 burned 应记下第 1 趟')
  console.log('  记账 :', JSON.stringify(st.plan))
  stopAll(rec)
}

/* ─────────── D 心情落盘 ─────────── */
console.log('\n── D 心情落盘 ──')
{
  const mood = readJson(PATHS.moodFile)
  check(mood && typeof mood.affinity === 'number', 'D mood.json 应该写出来')
  check(typeof mood?.baseEnergy === 'number', 'D energy 应该是数')
  console.log('  心情 :', JSON.stringify(mood))
}

console.log('\n' + '─'.repeat(52))
if (problems.length) {
  console.log('✗ 冒烟失败：')
  for (const p of problems) console.log('  - ' + p)
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
  } catch {}
  process.exit(1)
}
console.log('✓ 冒烟通过（6 组场景）')
try {
  fs.rmSync(ROOT, { recursive: true, force: true })
} catch {}
