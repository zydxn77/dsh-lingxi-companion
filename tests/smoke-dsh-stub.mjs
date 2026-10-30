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

// 2026-10-29 晚：**把时钟钉死**。
//   原来这套冒烟用真实时间，于是 23:30 之后跑必然全红 —— 因为活跃窗口是 09:00–23:30，
//   `inWindow` 为假，一次都不投。CI 半夜跑就是红的，而且看起来像代码坏了。
//   现在钉在 14:00（窗口正中），跟跑测试的钟点无关。
const FIXED_MS = new Date(2026, 9, 29, 14, 0, 0).getTime()
// 2026-10-30：改成可拨的 —— H 场景要测「11-01 的月度并进收尾」。
let NOW_MS = FIXED_MS
const setNow = (ms) => {
  NOW_MS = ms
}
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW_MS)
    else super(...args)
  }
  static now() {
    return NOW_MS
  }
}
globalThis.Date = FrozenDate

// 2026-10-30 第七刀：醒来改成概率了，冒烟里把它钉死 —— 掷到底，保证「该醒就醒」。
//   要测「不醒」的场景（窗口外 / 最小间隔内 / 暂停期）另有条件挡住，不受这个影响。
Math.random = () => 0.0001
const ROOT = path.join(os.tmpdir(), 'lingxi-smoke-' + process.pid)
fs.rmSync(ROOT, { recursive: true, force: true })
const WORKSPACE = path.join(ROOT, 'ws')
const DSH = path.join(ROOT, 'dsh')
const SESSIONS = path.join(DSH, 'sessions')
fs.mkdirSync(WORKSPACE, { recursive: true })
fs.mkdirSync(SESSIONS, { recursive: true })

process.env.LINGXI_WORKSPACE = WORKSPACE
process.env.DSH_HOME = DSH

const { PATHS, localDateKey, yesterdayKey, writeState, readState, readJson } = await import('../lib/home.js')
const { apply } = await import('../lib/index.js')
const { findMainSession } = await import('../lib/spine.js')
const { MAX_FAILS_PER_SLOT, PULSE_TEXT, SCAFFOLD_SOURCE_KIND } = await import('../lib/const.js')

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
  const rec = { created: [], renamed: [], sent: [], cleanups: [], listeners: {} }
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
    ...(overrides.__bus === true
      ? {
          on(event, fn) {
            rec.listeners[event] = fn
            return () => {
              delete rec.listeners[event]
            }
          },
        }
      : {}),
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
// 2026-10-30 第六刀：每天第一趟是**收尾趟**。
//   A/B/C 这些场景测的是「日记趟」的行为，所以先把「昨天已收」写上，
//   否则第一趟全被收尾占掉，测的就不是原来那条链了。收尾自己由 E 场景单测。
const YD = yesterdayKey(new Date())
const seedPlan = (over = {}) => ({
  key: today(),
  // 2026-10-30 第七刀：不再有 times —— lastAt 是「上次醒的时间」，0 = 没有冷却。
  //   count 只统计今天醒过几次，不限制。
  lastAt: 0,
  count: 0,
  fails: 0,
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
  writeState({ plan: seedPlan(), closingDay: YD })
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
  check(st.plan?.count === 1, `A 记账 count 应为 1，实际 ${st.plan?.count}`)
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

/* ───────── A2 脉冲 + 指令：他不该看见正文 ───────── */
console.log('\n── A2 脉冲 + 指令 ──')
{
  ageAll()
  writeState({ plan: seedPlan(), closingDay: YD })
  const { ctx, rec } = makeCtx({ __bus: true })
  apply(ctx, {})
  await settle()

  check(rec.sent.length === 1, `A2 应该说 1 次话，实际 ${rec.sent.length}`)
  const r = rec.sent[0]
  if (r) {
    const pulse = r.content?.[0]?.text
    check(pulse === PULSE_TEXT, `A2 投的应是脉冲「${PULSE_TEXT}」，实际 ${JSON.stringify(pulse)}`)
  }

  const listener = rec.listeners['agent/pre-step']
  check(typeof listener === 'function', 'A2 应挂上 agent/pre-step')

  if (typeof listener === 'function' && r) {
    const pulseMsg = {
      role: 'user',
      content: [{ type: 'text', text: PULSE_TEXT }],
      source: { kind: 'user', rpcId: r.requestId },
    }
    // 别人的指令消息（比如 grill-me）不能被她吞掉
    const foreign = {
      role: 'user',
      content: [{ type: 'text', text: 'x' }],
      source: { kind: 'grill-me', form: 'directive' },
    }
    const out = await listener({ agent: {} }, async () => ({
      kind: 'enter',
      messages: [pulseMsg, foreign],
    }))
    const injected = (out?.messages ?? []).filter((m) => m?.source?.kind === SCAFFOLD_SOURCE_KIND)
    check(injected.length === 1, `A2 应挂 1 条指令，实际 ${injected.length}`)
    const body = injected[0]?.content?.[0]?.text ?? ''
    check(body.includes('【到点了】'), 'A2 指令里应带「到点了」')
    check(body.includes('灵溪日记/'), 'A2 指令里应带今天的日记路径')
    check(/灵溪/.test(body) || /你是/.test(body), 'A2 指令第一行应是人设')
    check((out?.messages ?? []).includes(pulseMsg), 'A2 脉冲不能被吞掉')
    check((out?.messages ?? []).includes(foreign), 'A2 不该吞掉别人的指令消息')
    check(body.includes('接着补') || body.includes('从零写'), 'A2 应带上日记现在写到哪了')

    // 消费一次之后不该再挂（指令不算消息、不走幂等键，重投就会挂两份）
    const again = await listener({ agent: {} }, async () => ({ kind: 'enter', messages: [pulseMsg] }))
    const second = (again?.messages ?? []).filter((m) => m?.source?.kind === SCAFFOLD_SOURCE_KIND)
    check(second.length === 0, `A2 指令只该挂一次，第二次又挂了 ${second.length} 条`)
  }
  stopAll(rec)
}

/* ─────────────── B 他正在用，别打断 ─────────────── */
console.log('\n── B 他正在用 ──')
{
  // 主会话刚被动过 → 他正在说话
  const f = path.join(SESSIONS, '--ws--', 'session-main', SESSION_FILE)
  fs.utimesSync(f, new Date(), new Date())
  writeState({ plan: seedPlan(), heardAt: Date.now() - 30 * 60_000, selfQuietUntil: 0, closingDay: YD })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()

  check(rec.sent.length === 0, `B 不该插话，实际插了 ${rec.sent.length}`)
  const st = readState()
  check(Number.isFinite(st.plan?.deferSince), 'B 应该记下 deferSince')
  check(st.plan?.count === 0, `B count 不该前进，实际 ${st.plan?.count}`)
  console.log('  记账 :', JSON.stringify(st.plan))
  stopAll(rec)
}

/* ─────────── C1 失败一次记一次 ─────────── */
console.log('\n── C1 失败一次记一次 ──')
{
  const f = path.join(SESSIONS, '--ws--', 'session-main', SESSION_FILE)
  fs.utimesSync(f, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000))
  writeState({ plan: seedPlan(), closingDay: YD })
  const { ctx, rec } = makeCtx()
  ctx.sessionController = failCtrl(rec)
  apply(ctx, {})
  await settle()

  const st = readState()
  check(st.plan?.fails === 1, `C1 fails 应为 1，实际 ${st.plan?.fails}`)
  check(st.plan?.count === 0, `C1 count 不该前进，实际 ${st.plan?.count}`)
  console.log('  记账 :', JSON.stringify(st.plan))
  stopAll(rec)
}

/* ─────────── C2 熔断 ─────────── */
console.log('\n── C2 连续失败到上限就熔断 ──')
{
  ageAll()
  writeState({ plan: seedPlan({ fails: MAX_FAILS_PER_SLOT - 1 }), closingDay: YD })
  const { ctx, rec } = makeCtx()
  ctx.sessionController = failCtrl(rec)
  apply(ctx, {})
  await settle()

  const st = readState()
  check(st.plan?.count === 1, `C2 熔断后 count 应为 1，实际 ${st.plan?.count}`)
  check(st.plan?.fails === 0, `C2 熔断后 fails 应清零，实际 ${st.plan?.fails}`)
  check(Number.isFinite(st.plan?.lastAt) && st.plan.lastAt > 0, 'C2 熔断后要把 lastAt 推到当下（进最小间隔，不再连撞）')
  console.log('  记账 :', JSON.stringify(st.plan))
  stopAll(rec)
}

/* ─────────── E 收尾趟：每天第一趟收昨天 ─────────── */
console.log('\n── E 收尾趟 ──')
{
  ageAll()
  // 昨天还没收过 → 这一趟该是**收尾**，不是日记趟
  writeState({ plan: seedPlan(), closingDay: null })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()

  const st = readState()
  check(rec.sent.length === 1, `E 收尾趟该投 1 次，实际 ${rec.sent.length}`)
  const r = rec.sent[0]
  if (r) {
    check(r.requestId === `lingxi-close-${YD}`, `E requestId 应是收尾键，实际 ${r.requestId}`)
    const text = r.content?.[0]?.text ?? ''
    check(text.includes('一天的尾巴'), 'E 该是收尾提示')
    check(!/整理|总结|必须|应该/.test(text), 'E 提示里不许有祈使（§7.4）')
  }
  check(st.closingDay === YD, `E 该记下 closingDay=${YD}，实际 ${st.closingDay}`)
  check(st.plan?.count === 0, `E 收尾趟不该动日记趟的账，实际 count=${st.plan?.count}`)
  console.log('  记账 :', JSON.stringify({ closingDay: st.closingDay, count: st.plan?.count }))
  stopAll(rec)
}

/* ─────────── F 风险暂停：停了就一个字都不投 ─────────── */
console.log('\n── F 风险暂停 ──')
{
  ageAll()
  // 账上记着「连着投不出去 5 次，刚发生」→ 这一趟该直接停
  writeState({
    plan: seedPlan(),
    closingDay: YD,
    failStreak: 5,
    breaker: { at: Date.now() - 60_000, n: 5, reason: '测试' },
  })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()

  check(rec.sent.length === 0, `F 暂停期内不许投递，实际投了 ${rec.sent.length}`)
  const st = readState()
  check(st.breaker?.n === 5, 'F 账上的暂停记录不该被清掉')
  check(st.plan?.count === 0, `F 暂停期内不该动账，实际 count=${st.plan?.count}`)
  console.log('  记账 :', JSON.stringify({ breaker: st.breaker?.n, failStreak: st.failStreak }))
  stopAll(rec)
}

{
  ageAll()
  // 差一次就打开：ownSession 强制开，但这里一个 lingxi-* 会话都没有 → 投不到 → 计入失败
  process.env.LINGXI_OWN_SESSION = '1'
  writeState({ plan: seedPlan(), closingDay: YD, failStreak: 4 })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()
  delete process.env.LINGXI_OWN_SESSION

  const st = readState()
  check(rec.sent.length === 0, `F2 投不到就不该投，实际投了 ${rec.sent.length}`)
  check(
    st.breaker?.n === 5,
    `F2 第 5 次该把断路器打开，实际 failStreak=${st.failStreak} breaker=${st.breaker?.n}`,
  )
  console.log('  记账 :', JSON.stringify({ breaker: st.breaker?.n, failStreak: st.failStreak }))
  stopAll(rec)
}

/* ─────────── H 月度并进收尾（§13.2 定稿，2026-10-30）─────────── */
console.log('\n── H 月度并进收尾 ──')
{
  setNow(new Date(2026, 10, 1, 10, 0, 0).getTime()) // 11-01 10:00
  ageAll()
  // 月度重读要求「有日记可读」，否则 monthlyDue 返回 false
  fs.mkdirSync(PATHS.diaryDir, { recursive: true })
  fs.writeFileSync(path.join(PATHS.diaryDir, '2026-10-31.txt'), '2026-10-31\n\n那天留下了点东西。\n', 'utf8')
  writeState({ plan: seedPlan({ key: '2026-11-01' }), closingDay: null, monthly: null })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()

  check(rec.sent.length === 1, `H 该投 1 次（收尾+月度合一），实际 ${rec.sent.length}`)
  const r = rec.sent[0]
  if (r) {
    const text = r.content?.[0]?.text ?? ''
    check(text.includes('一天的尾巴'), 'H 要含收尾段')
    check(text.includes('又到一个月了'), 'H 要含月度段')
    check(r.requestId === 'lingxi-close-2026-10-31', `H requestId 应是收尾键，实际 ${r.requestId}`)
  }
  const st = readState()
  check(st.closingDay === '2026-10-31', `H closingDay 应为 2026-10-31，实际 ${st.closingDay}`)
  check(st.monthly === '2026-11', `H monthly 应记为 2026-11，实际 ${st.monthly}`)
  console.log('  记账 :', JSON.stringify({ closingDay: st.closingDay, monthly: st.monthly }))
  setNow(FIXED_MS)
  stopAll(rec)
}
/* ─────────── H2 收尾已做、月度没做 → 概率醒补做（glm-5.3 指出的盲区）─────────── */
console.log('\n── H2 月度兜底 ──')
{
  // 挪到 12-01：H 场景把进程内的 memMonthly 设成了 2026-11，同月会挡住这一测
  setNow(new Date(2026, 11, 1, 12, 0, 0).getTime()) // 12-01 12:00
  ageAll()
  // 收尾今天做过了，但月度没并进来 —— 这时概率醒要单独补一次月度
  writeState({ plan: seedPlan({ key: '2026-12-01' }), closingDay: '2026-11-30', monthly: null })
  const { ctx, rec } = makeCtx()
  apply(ctx, {})
  await settle()

  check(rec.sent.length === 1, `H2 该投 1 次（概率醒补月度），实际 ${rec.sent.length}`)
  const text = rec.sent[0]?.content?.[0]?.text ?? ''
  check(text.includes('又到一个月了'), 'H2 要含月度段')
  check(!text.includes('一天的尾巴'), 'H2 不该再含收尾段')
  check(readState().monthly === '2026-12', `H2 monthly 应记 2026-12，实际 ${readState().monthly}`)
  console.log('  记账 :', JSON.stringify({ monthly: readState().monthly }))
  setNow(FIXED_MS)
  stopAll(rec)
}
/* ─────────── H3 1–3 日可补、4 日不补（glm-5.3 指出的盲区）─────────── */
console.log('\n── H3 补做窗口 ──')
{
  // 11-03：还在 1–3 日内 → 收尾 + 月度合并
  setNow(new Date(2026, 10, 3, 10, 0, 0).getTime())
  ageAll()
  writeState({ plan: seedPlan({ key: '2026-11-03' }), closingDay: null, monthly: null })
  {
    const { ctx, rec } = makeCtx()
    apply(ctx, {})
    await settle()
    const text = rec.sent[0]?.content?.[0]?.text ?? ''
    check(rec.sent.length === 1, `H3a 11-03 该投 1 次，实际 ${rec.sent.length}`)
    check(text.includes('一天的尾巴') && text.includes('又到一个月了'), 'H3a 11-03 该含收尾+月度')
    check(readState().monthly === '2026-11', `H3a monthly 应为 2026-11，实际 ${readState().monthly}`)
    console.log('  记账 :', JSON.stringify({ monthly: readState().monthly }))
    stopAll(rec)
  }

  // 11-04：过了 3 日 → 只收尾，月度不做
  setNow(new Date(2026, 10, 4, 10, 0, 0).getTime())
  ageAll()
  writeState({ plan: seedPlan({ key: '2026-11-04' }), closingDay: null, monthly: null })
  {
    const { ctx, rec } = makeCtx()
    apply(ctx, {})
    await settle()
    const text = rec.sent[0]?.content?.[0]?.text ?? ''
    check(rec.sent.length === 1, `H3b 11-04 该投 1 次，实际 ${rec.sent.length}`)
    check(text.includes('一天的尾巴'), 'H3b 11-04 该含收尾段')
    check(!text.includes('又到一个月了'), 'H3b 11-04 过了 3 日，不该再做月度')
    check(readState().monthly === null, `H3b monthly 应仍为空，实际 ${readState().monthly}`)
    stopAll(rec)
  }
  setNow(FIXED_MS)
}
/* ─────────── D 心情层已拆除 ─────────── */
console.log('\n── D 心情层已拆除 ──')
{
  // 2026-10-29 按架构 §4 拆除：原来这里查 mood.json 里的 affinity / baseEnergy。
  //   现在反过来查 —— 跑完全部场景后，**不该再产出这个文件**（回归保险）。
  const mood = readJson(PATHS.moodFile)
  check(mood === null, `D 不该再写 mood.json，实际 ${JSON.stringify(mood)}`)
  console.log('  心情文件 :', mood === null ? '不存在（符合预期）' : '存在了，有问题')
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
console.log('✓ 冒烟通过（13 组场景）')
try {
  fs.rmSync(ROOT, { recursive: true, force: true })
} catch {}
