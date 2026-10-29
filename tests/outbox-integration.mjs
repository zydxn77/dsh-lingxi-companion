/**
 * 端到端集成测试：「她想说话 → 外发箱 → 投递」（2026-10-29 晚加的这条通道）。
 *
 *   node tests/outbox-integration.mjs
 *
 * 做法照 `tests/smoke-dsh-stub.mjs`：自己建临时 `DSH_HOME` 和临时工作区，
 * 用桩件顶替 `ctx.sessionController`，然后 `apply(ctx, {})` 把 **真 tick** 跑一遍。
 *
 * **不碰真实工作区、不投真实消息**：所有读写都在 `os.tmpdir()` 下，跑完删掉；
 * 写箱子之前还会再核一次路径（见 assertInsideWorkspace）——宁可测试报错，
 * 也不许它落到真实工作区里。
 *
 * 验的是四件事（对应任务里的 5 条）：
 *   P  前置     → 工作区在临时目录、箱路径落在里面、路由开关关着
 *   A  有话要说 → 恰好投一条；目标是**主会话**（delegationDepth=0，不是更新的子 agent、
 *                 也不是她自己那些 lingxi-* 会话）；正文带 `[[lingxi-say]]`、含那句话；
 *                 投完之后**那一条从箱子里被删掉**
 *   B  箱子空的 → **一条都不投**；而且能证明拦住它的是「空箱」，
 *                 不是时段、不是 20 分钟间隔（同一时刻、同一份账，箱子一有内容就投）
 *   C  投不出去 → 箱子原样不动、不记账（「投递成功才删」这条语义）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

/* ── 把时钟钉死（smoke-dsh-stub.mjs 踩过的坑，照抄）──────────────────
 * 外发箱只在 09:00–22:00 投（`SAY_FROM_HOUR`/`SAY_TO_HOUR`），唤醒窗口是
 * 09:00–23:30。用真实时间的话，23:30 之后跑这套必然全红 —— `inWindow` 为假、
 * 一次都不投，看起来像代码坏了。
 * 钉在 14:00（两个窗口正中），跟跑测试的钟点无关。
 */
const FIXED_MS = new Date(2026, 9, 29, 14, 0, 0).getTime()
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_MS)
    else super(...args)
  }
  static now() {
    return FIXED_MS
  }
}
globalThis.Date = FrozenDate

/* ── 临时工作区 / 临时 DSH_HOME ─────────────────────────────────────
 * 必须在 import lib 之前设好：home.js 在模块加载时就解析 PATHS 与 PROFILE。
 */
const ROOT = path.join(os.tmpdir(), 'lingxi-outbox-' + process.pid)
fs.rmSync(ROOT, { recursive: true, force: true })
const WORKSPACE = path.join(ROOT, 'ws')
const DSH = path.join(ROOT, 'dsh')
const SESSIONS = path.join(DSH, 'sessions')
fs.mkdirSync(WORKSPACE, { recursive: true })
fs.mkdirSync(SESSIONS, { recursive: true })

process.env.LINGXI_WORKSPACE = WORKSPACE
process.env.DSH_HOME = DSH
// 路由开关必须是关的：`spine.say` 里 `wantOwn = ownSession || LINGXI_OWN_SESSION`
// —— 真的是设了的话，外发箱会被路由到她自己的会话，测的就不是这件事了。
delete process.env.LINGXI_OWN_SESSION

const { PROFILE, localDateKey, readState, writeState } = await import('../lib/home.js')
const { apply } = await import('../lib/index.js')
const { sayBoxPath, sayDue, sayWireText, SAY_MARK } = await import('../lib/outbox.js')

/* ── 断言 ─────────────────────────────────────────────────────────── */
let pass = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log('  ok   ' + name)
  } else {
    failures.push(name + (detail ? '  ← ' + detail : ''))
    console.log('  ✗    ' + name + (detail ? '  ← ' + detail : ''))
  }
  return Boolean(cond)
}

/* ── 安全闸：只许写临时工作区里 ──────────────────────────────────── */
const wsAbs = path.resolve(WORKSPACE)
const REAL_WORKSPACE = path.join(os.homedir(), 'OneDrive', '文档', 'deepseek-harness', 'default-workspace')
function assertInsideWorkspace(file) {
  const abs = path.resolve(file)
  const inWs = abs === wsAbs || abs.startsWith(wsAbs + path.sep)
  if (!inWs) throw new Error('拒绝在临时工作区之外读写：' + abs)
  return abs
}
const BOX = assertInsideWorkspace(sayBoxPath())

const SESSION_FILE = 'session.v4.jsonl.zstd'

/**
 * 造一个会话：header 是第一帧，插件靠它认主会话（spine.js 的 findMainSession）。
 * 目录名 = 会话 id，`lingxi*` 开头的会被当成她自己的会话排掉。
 */
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

/** 桩件：记下 create / rename / prompt 都收到了什么 */
function makeCtx({ promptImpl = null } = {}) {
  const rec = { created: [], renamed: [], sent: [], attempts: [], cleanups: [] }
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
        rec.attempts.push(req)
        if (signal?.aborted) throw new Error('aborted')
        if (promptImpl) return promptImpl(req, signal)
        rec.sent.push(req)
        return { accepted: true }
      },
    },
    effect(fn) {
      rec.cleanups.push(fn())
    },
  }
  return { ctx, rec }
}

const settle = () => new Promise((r) => setTimeout(r, 900))
const stopAll = (rec) => rec.cleanups.forEach((c) => c?.())

/** 跑一个真 tick：apply() 的 effect 会立刻 tick 一次（index.js 末尾） */
async function runTick(opts) {
  const { ctx, rec } = makeCtx(opts)
  apply(ctx, {})
  await settle()
  return rec
}

const writeBox = (items) => {
  assertInsideWorkspace(BOX)
  fs.writeFileSync(BOX, JSON.stringify({ items }, null, 2) + '\n', 'utf8')
}
const readBox = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(BOX, 'utf8'))
    return Array.isArray(raw?.items) ? raw.items : []
  } catch {
    return null
  }
}

const today = () => localDateKey(new Date())

/**
 * 今天的账。
 *
 * ⚠️ 两处刻意为之，否则这条测试会串味：
 *   · `done = times.length` → `decide` 返回 `idle`，**不会走唤醒投递**
 *     （否则唤醒那一趟也会往会话里投一段，`sent.length` 就不是 1 了）；
 *   · `roam` 预置成今天、且时刻在未来 → 游荡不 due。
 *     游荡那一段在 outbox 之前，一旦 due 它会 `return`，外发箱永远走不到。
 */
function seedState() {
  const key = today()
  return {
    plan: {
      key,
      skip: false,
      times: [FIXED_MS - 60_000],
      done: 1,
      fails: 0,
      deferSlot: null,
      deferSince: null,
      roam: { key, times: [FIXED_MS + 3_600_000], done: 0 },
    },
    lastSayAt: 0,
    sayDay: null,
    sayCount: 0,
  }
}

/* ═════════════════ P 前置：确实是临时工作区 ═════════════════ */
console.log('\n── P 前置 ──')
{
  const tmpAbs = path.resolve(os.tmpdir())
  const realAbs = path.resolve(REAL_WORKSPACE)
  check('P1 工作区在系统临时目录里', wsAbs.startsWith(tmpAbs + path.sep), wsAbs)
  check(
    'P2 不在真实工作区（及其子目录）里',
    wsAbs !== realAbs && !wsAbs.startsWith(realAbs + path.sep),
    wsAbs,
  )
  check('P3 箱路径落在临时工作区里', BOX.startsWith(wsAbs + path.sep), BOX)
  check(
    'P4 箱文件名来自 profile（默认档案里有 sayBox，不写死在 lib 里）',
    typeof PROFILE.sayBox === 'string' && PROFILE.sayBox.length > 0,
    'PROFILE.sayBox = ' + JSON.stringify(PROFILE.sayBox),
  )
  check('P5 路由开关是关着的（否则会投她自己那个会话）', !process.env.LINGXI_OWN_SESSION)
  check('P6 钉死的时钟落在投递时段内（09:00–22:00）', new Date().getHours() === 14)
  console.log('  临时工作区 :', WORKSPACE)
  console.log('  箱         :', BOX)
}

/* ── 造三个会话：她的一个（最新）、子 agent 一个、主会话一个（最旧）──
 * 主会话排最后，是为了让「投给谁」这件事真的被测到：
 * 只按 mtime 取最新，就会投错。
 */
const MAIN_ID = 'session-main'
makeSession({ id: 'lingxi-old', dirName: 'lingxi-old', depth: 0, ageMs: 0 })
makeSession({ id: 'session-sub', depth: 2, ageMs: 30_000 })
makeSession({ id: MAIN_ID, depth: 0, ageMs: 60_000 })

/* ═════════════════ A 有话要说：投一条，投完删掉 ═════════════════ */
console.log('\n── A 她想说话：投递到主会话 ──')
{
  writeBox([{ text: '测试一句', why: '验证通道' }])
  writeState(seedState())

  const recA = await runTick()
  const req = recA.sent[0]
  const text = req?.content?.[0]?.text ?? ''

  check('A1 恰好投了一条（不多不少）', recA.sent.length === 1, '实际 ' + recA.sent.length)
  check('A2 没有新开会话（话投进已有的会话）', recA.created.length === 0, '实际建了 ' + recA.created.length)
  check('A3 没有 rename', recA.renamed.length === 0, '实际 ' + recA.renamed.length)
  check(
    'A4 目标是主会话（delegationDepth=0 的那个）',
    req?.sessionId === MAIN_ID,
    '实际 ' + JSON.stringify(req?.sessionId) + ' —— 更新的子 agent / 她自己的会话都不该被选中',
  )
  check('A5 mode 是 queue（排队，不抢他正在说的）', req?.mode === 'queue', '实际 ' + JSON.stringify(req?.mode))
  check(
    'A6 带 requestId（SessionPromptRequest 必填，也是幂等键）',
    typeof req?.requestId === 'string' && req.requestId.length > 0,
    JSON.stringify(req?.requestId),
  )
// 2026-10-30 改：id 不再用「日期+计数」，改成**正文内容的哈希**。
//   原因：计数存在 state 里，写盘失败时不涨 → 下一条复用同一个 id →
//   若宿主把"同 id"当成功，就会删掉一条用户从没见过的消息。
//   内容哈希：同一条永远同 id（幂等兜住重复），不同内容永远不同 id（不撞车）。
const wantId = `lingxi-say-${today()}-` + createHash('sha1').update(sayWireText({ text: '测试一句' })).digest('hex').slice(0, 12)
check('A7 requestId 由正文内容决定（同一条永远同 id）', req?.requestId === wantId, String(req?.requestId))
check(
  'A7b 换一句内容 → 换一个 id（不会撞车）',
  wantId !== `lingxi-say-${today()}-` + createHash('sha1').update(sayWireText({ text: '另一句' })).digest('hex').slice(0, 12),
  '两条不同内容的 id 不该相同',
)
  check(
    'A8 正文只有一段文字（不是拆成两段）',
    req?.content?.length === 1 && req.content[0]?.type === 'text',
    JSON.stringify(req?.content?.map((c) => c?.type)),
  )
  check('A9 正文以 [[lingxi-say]] 开头', text.startsWith(SAY_MARK), JSON.stringify(text.slice(0, 24)))
  check('A10 正文包含「测试一句」', text.includes('测试一句'), JSON.stringify(text))
  check(
    'A11 正文就是那一句（没混进唤醒话术）',
    text === sayWireText({ text: '测试一句' }),
    JSON.stringify(text),
  )

  const after = readBox()
  check(
    'A12 投递成功后那一条从箱子里被删掉',
    Array.isArray(after) && after.length === 0,
    JSON.stringify(after),
  )

  const st = readState()
  check('A13 投递后记账 lastSayAt = 现在', st.lastSayAt === FIXED_MS, String(st.lastSayAt))
  check(
    'A14 投递后记账 sayCount = 1 / sayDay = 今天',
    st.sayCount === 1 && st.sayDay === today(),
    JSON.stringify({ sayDay: st.sayDay, sayCount: st.sayCount }),
  )

  console.log('  投进 :', req?.sessionId)
  console.log('  正文 :', JSON.stringify(text))
  console.log('  箱子 :', JSON.stringify(after))
  stopAll(recA)
}

/* ═════════════════ B 箱子空的：一条都不投 ═════════════════ */
console.log('\n── B 箱子是空的：一条都不投 ──')
{
  // 账本重置（否则 A 刚记的 lastSayAt 会触发「刚说过」，
  // 那样 B 会因为**间隔**而通过 —— 测不出「空箱不投」这件事）。
  writeBox([])
  writeState(seedState())

  const recB = await runTick()
  check('B1 一条都不该收到', recB.sent.length === 0, '实际投了 ' + recB.sent.length)
  check('B2 连 prompt 都没调过', recB.attempts.length === 0, '实际尝试 ' + recB.attempts.length)

  // 把「拦住它的是空箱」直接证出来：其余条件一模一样，只是箱里有话。
  const now = new Date()
  const emptyGate = sayDue({ now, lastSayAt: 0, todayCount: 0, box: [] })
  const fullGate = sayDue({ now, lastSayAt: 0, todayCount: 0, box: [{ text: 'x' }] })
  check('B3 空箱时闸的理由是「箱子是空的」', emptyGate.due === false && emptyGate.why === '箱子是空的', JSON.stringify(emptyGate))
  check(
    'B4 对照：同一时刻、同一份账，箱里有话就会投（B1 不是靠别的条件凑出来的）',
    fullGate.due === true,
    JSON.stringify(fullGate),
  )

  const st = readState()
  check('B5 空箱时不记账（lastSayAt 仍是 0）', (st.lastSayAt ?? 0) === 0, String(st.lastSayAt))
  const boxB = readBox()
  check('B6 空箱时箱子文件没被动', Array.isArray(boxB) && boxB.length === 0, JSON.stringify(boxB))
  stopAll(recB)
}

/* ═════════════════ C 投不出去：箱子不能丢 ═════════════════ */
console.log('\n── C 投不出去（agent-busy）：箱子留着，下个 tick 再试 ──')
{
  writeBox([{ text: '投不出去的一句' }, { text: '第二条' }])
  writeState(seedState())

  const recC = await runTick({
    promptImpl: () => {
      const e = new Error('prompt rejected')
      e.code = 'session/agent-busy'
      throw e
    },
  })

  check('C1 只尝试了 1 次（没把第二条也拿去投）', recC.attempts.length === 1, '实际 ' + recC.attempts.length)
  check('C2 失败的那条不算投递成功', recC.sent.length === 0, '实际 ' + recC.sent.length)

  const boxC = readBox() ?? []
  check(
    'C3 失败后箱子原样不动（一条都没删，顺序不变）',
    boxC.length === 2 && boxC[0].text === '投不出去的一句' && boxC[1].text === '第二条',
    JSON.stringify(boxC),
  )

  const st = readState()
  check('C4 失败不记账（lastSayAt 仍是 0）', (st.lastSayAt ?? 0) === 0, String(st.lastSayAt))
  stopAll(recC)
}

/* ═════════════════ 汇总 ═════════════════ */
console.log('\n' + '─'.repeat(52))
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败（通过 ${pass} 条）：`)
  for (const f of failures) console.log('  - ' + f)
  console.log('  临时目录保留一份供排查：' + ROOT)
  process.exit(1)
}
console.log(`✓ 外发箱集成测试通过（${pass} 条断言）`)

// 只删自己建的那个临时目录（路径在开头就核过是 os.tmpdir() 下面的）
try {
  fs.rmSync(ROOT, { recursive: true, force: true })
} catch {}