/**
 * dsh-lingxi-companion —— 灵溪的作息层。
 *
 * 她不是被插件「替她说」，是被插件「叫醒」。
 *
 * 每 60 秒 tick 一次 → 看今天该不该醒 → 到点了**给她开一个新会话**，
 * 会话里第一句就是唤醒提示 → 那个会话里的灵溪自己读日记、看今天、写日记。
 *
 * 「主动开口」= 她自己开一个新会话出现在他的侧栏里。
 * 所以每天最多 3 次，也就是最多 3 个新会话。
 *
 * 这个插件本身几乎不说话。它只负责「什么时候叫」「叫醒时她第一眼看到什么」
 * 「这一趟给她起个新会话」。
 */
import {
  TICK_MS,
  EXPECTED_GAP_MS,
  SESSION_PREFIX,
  WAKE_WINDOW,
  IDLE_MS,
  COOLDOWN_MS,
  WAKE_TIMEOUT_MS,
  MAX_FAILS_PER_SLOT,
  HE_BUSY_MS,
  MAX_DEFER_MS,
  ROAM_GRACE_MS,
  CHANGES_HOURS,
  CHANGES_LIMIT,
  CHANGES_DEPTH,
  NIGHT_HOUR,
  SELF_QUIET_MS,
  SCAFFOLD_SOURCE_KIND,
  SCAFFOLD_FORM,
  PULSE_TEXT,
  TIER_MIN,
  TIER_DEFAULT,
  TIER_RAISE_AFTER_DAYS,
  SPEAKS_PER_DAY_MAX,
} from './const.js'
import { PATHS, readState, writeState, appendLog, localDateKey, readJson, readText, diaryPath } from './home.js'
import {
  stylePath,
  loadStyle,
  saveStyle,
  styleSnapshot,
  recordStyle,
} from './style.js'
import { proposalsPath, loadProposals, saveProposals, applyReady } from './revision.js'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 会话路由开关：读 `.lingxi/config.json` 里的 `ownSession`。
 *
 * 2026-10-27 改：原来只认环境变量 `LINGXI_OWN_SESSION` —— 太别扭。
 * 设一次、完整重启一次，还容易被"旧进程继承的旧环境"骗过去
 * （第一次验就栽在这：重启了但变量没进去，日志里两行都不出现，分不清"没开"还是"找不到会话"）。
 * 改成读文件：改一个字就生效，不碰环境变量、不重启。
 * 环境变量仍然认，优先级更高，方便临时试。
 */
function readOwnSessionFlag() {
  const env = process.env.LINGXI_OWN_SESSION
  if (env !== undefined && String(env) !== '0' && String(env) !== '') return true
  const cfg = readJson(path.join(PATHS.stateDir, 'config.json'))
  return cfg?.ownSession === true
}
import { shouldWake, inWindow, hhmm } from './clock.js'
import { buildPulse, buildWakeText } from './prompt.js'
// 2026-10-30 第七刀：游荡的调度函数删了（roam.js 只剩 ROAM_LOG 与 roamLogHint）。
import { monthlyDue, monthlyPrompt, prevSummaryPath, writeIndex, monthKey } from './monthly.js'
import { closingDue, closingPrompt, yesterdayKey } from './closing.js'
import { breakerOpen, breakerFail, breakerOk, breakerWhy } from './breaker.js'
import { migratePlainIntoStreams } from './store.js'
import { loadSayBox, dropSay, sayDue, sayWireText } from './outbox.js'
import { createHash } from 'node:crypto'
import { createSpine } from './spine.js'
import { daysSince } from './mood.js'
import { hourWeights, deriveWindow } from './presence.js'
import {
  loadExpectations,
  saveExpectations,
  advance as advanceExpectations,
  pickForWake,
} from './expectations.js'
import { loadTasks } from './tasks.js'
import { recentChanges } from './workspace.js'
import { playPing } from './sound.js'
import { pickFlashback } from './flashback.js'
import { loadRecall, saveRecall, recallOne, touchRecall } from './recall.js'
import { loadFeedback, saveFeedback, advanceFeedback, expectedGapFor } from './feedback.js'

// ⚠️ 一条数组写全。写成两个键（例如再补一行 inject）会被后一个覆盖 →
//    sessionController 没被注入 → 每 60 秒静默 return，不报错也不干活。
//    这个坑原版踩过，注释就留在它的源码里。
const inject = ['sessionController']
const name = 'dsh-lingxi-companion'

/**
 * 今天最多开几次口 —— **只看频率档位，不看沉默多久**（2026-10-29 按架构 §9 改）。
 *
 * 原来这里是 `openingsFor(daysSinceHeard, tier)`：他越久不说话，趟数压得越少
 * （normal 3 / quiet 2 / faint 1）。那是「沉默惩罚」——文档 §9 明令禁止：
 * 他不来，不该变成她少醒的理由。
 *
 * 现在只认档位（他抱怨过就降、连着没抱怨就回升，见 feedback.js）。
 * 懒日由 decide 自己压到 1。
 */
function openingsFor(tier) {
  return Math.max(TIER_MIN, Math.min(Number(tier) || TIER_DEFAULT, SPEAKS_PER_DAY_MAX))
}

// 融合之后这两样都退役了：不再开新会话，也就没有「会话 id」和「标题」要造。
// 记录在案，别再加回来 —— 详见 README「一个灵溪，一条时间线」。

function apply(ctx, config = {}) {
  // console 在 Electron 主进程里是个黑洞 —— 每一行都同时落盘到 .lingxi/lingxi.log
  const log = (m) => {
    console.log('[lingxi] ' + m)
    appendLog(m)
  }
  const warn = (m) => {
    console.warn('[lingxi] ' + m)
    appendLog('!! ' + m)
  }

  // 2026-10-29 第五刀：老账本若还留在普通文件里（旧实例写的），挂载时搬进流并删掉。
  try {
    const moved = migratePlainIntoStreams(PATHS.stateDir)
    if (moved.length) console.log('[lingxi] 账本搬进数据流：' + moved.join(', '))
  } catch {}

  // 2026-10-29 第四刀：把 private 抽屉建出来（只建目录，永不读里面）。
  try {
    fs.mkdirSync(PATHS.privateDir, { recursive: true })
  } catch (e) {
    warn('private 目录建不出来：' + e.message)
  }

  let stopped = false
  let waking = false
  let wakingAt = 0
  let wakingWarned = false
  let busyUntil = 0
  /** 上一次被跳过的原因 —— 只记变化，免得每 60 秒刷一行 */
  let lastBusyReason = ''
  /** 进程内的 lastSay（写盘失败时的兜底），2026-10-30 加 */
  let memLastSay = 0
  /** 收尾趟连续投递失败次数 —— 只用来防日志刷屏，别拿它做任何判断 */
  let closingFailsInRow = 0
  /** 风险暂停的日志只说一次，别每 60 秒重复 */
  let breakerNoted = false
  /** 进程内记住「已经收过尾 / 已经做过月度」—— 写盘失败时的兜底。
   *  否则下个 tick 会拿同一个 requestId 再投，被宿主幂等挡成「投递失败」，五次就把断路器打误开。 */
  let memClosedDay = ''
  let memMonthly = ''
  /** 同一个 tick 不许并发执行：外发箱那段有 await，两个 tick 会各拿一份 state 快照互相覆盖。 */
  let ticking = false
  const lifecycle = new AbortController()

  const spine = createSpine({
    controller: ctx.sessionController,
    sessionsDir: PATHS.sessionsDir,
    sessionPrefix: SESSION_PREFIX,
    log,
  })

  /**
   * 待发货的指令：投递时先武装，等那一步真的开跑，再由 `agent/pre-step` 挂上去。
   *
   * 为什么不在投递时直接写进 `prompt`：他 2026-10-27 定死了 ——
   * **那条消息落在他的位置上，不该出现教学话术。**
   * `SessionPromptRequest` 只接受 {requestId, sessionId, mode, content}，没有
   * "非用户身份"的字段（strict codec，additionalProperties: false），
   * 所以「她主动开口」必然在他那边留一条 user 消息 —— 那就压到一个点。
   * 真正给她的人设、日记、素材走 `agent/pre-step` 的指令消息，他不渲染。
   *
   * 认领方式：这一批 messages 里必须有 `source.rpcId === requestId` 的那条脉冲。
   * 这样他同时打字、脉冲被排在后面时，不会把货挂到别人那一拍上。
   */
  let armed = null

  /**
   * 指令这条腿通不通。通 → 投脉冲，正文走 pre-step；不通 → 退回整段塞进 prompt。
   *
   * 为什么要有开关：`ctx.on` 不是每个宿主都有（桩件、headless 都可能没有）。
   * 没有它还只发脉冲，她就只收到一个「·」，不知道要做什么 —— 那比原来更糟。
   */
  let injectReady = false

  const disposeAll = []

  /**
   * 把待发货的指令挂进这一步。
   *
   * 三条约束（都是踩过的）：
   *   1. **永远不 reject** —— `{kind:'reject'}` 会让整轮以 blocked 收尾，
   *      可能把已经产生的工具结果悬空。只 enter。
   *   2. **只替换自己的 directive，别的一律原样放过** —— 把别人（比如 grill-me）
   *      的指令消息吞掉，等于让模型读不到它。
   *   3. **同一步只留一份** —— 指令消息不算消息、不走幂等键，重投一次就会挂两份。
   */
  const makeDirective = (text) =>
    Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze([Object.freeze({ type: 'text', text: String(text) })]),
      source: Object.freeze({ kind: SCAFFOLD_SOURCE_KIND, form: SCAFFOLD_FORM }),
    })

  const isOwnDirective = (m) =>
    m?.source?.kind === SCAFFOLD_SOURCE_KIND && m?.source?.form === SCAFFOLD_FORM

  async function onPreStep({ agent }, next) {
    const decision = await next()
    try {
      if (!armed) return decision
      if (decision === null || decision === undefined) return decision
      if (decision.kind === 'reject') return decision
      // 货过期了就丢掉：投递可能根本没落地，别挂在将来的某一拍上
      if (Date.now() - armed.at > WAKE_TIMEOUT_MS) {
        log('指令过期未送达，丢弃（这一趟没开口）')
        armed = null
        return decision
      }
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      if (!messages.length) return decision
      // 认领：优先按 requestId（他同时打字、脉冲被排队时也不会挂错拍）；
      // 退路按脉冲正文比 —— 万一这一步的 messages 不带 source，
      // 只认 requestId 会让指令永远挂不上，她只收到一个「·」，而且不报错。
      const claimed = messages.some(
        (m) =>
          m?.source?.rpcId === armed.requestId ||
          (Array.isArray(m?.content) &&
            m.content.some((c) => c?.type === 'text' && c.text === PULSE_TEXT)),
      )
      if (!claimed) return decision

      const owned = makeDirective(armed.text)
      const rewritten = messages.filter((m) => !isOwnDirective(m))
      rewritten.push(owned)
      armed = null
      log(`指令已挂上这一步（${owned.content[0].text.length} 字，⚠️ 界面上会显示）`)
      return { ...decision, kind: 'enter', messages: rewritten }
    } catch (e) {
      warn('pre-step 注入失败：' + (e?.message ?? e))
      return decision
    }
  }

  /**
   * 收尾趟：每天一次，收完整的前一天（架构 §7.7，2026-10-30 A 案）。
   *
   * 返回 true = 这一 tick 被它用掉了，后面的趟都别做。
   * 返回 false = 今天不用收 / 时机不对，正常往下走（不记失败，下一 tick 再看）。
   *
   * 三条边界，别在优化时踩掉：
   *   ① **不占趟数额度**。它不是「多开一次口」，是把昨天收起来 ——
   *      所以既不吃档位，也不吃「他今天说过烦」那一刀。
   *   ② **只收昨天**。前天永远轮不到（§7.7 兜底：丢一天就丢一天）。
   *   ③ **路由跟日记趟一致**。ownSession 开着时投她自己的会话、投不到就跳过；
   *      没开时和日记趟一样投主会话 —— 不自作主张走另一条路。
   */
  async function tryClosing({ now, state, window, lastHeard }) {
    if (!closingDue(now, state)) return false
    // 进程内也记一笔：写盘失败时 closingDay 没落盘，但这一次确实已经收过了
    if (memClosedDay === yesterdayKey(now)) return false
    // 窗口外不叫 —— 和别的趟同一条安全边界（他凌晨开机，等进窗口再收）
    if (!inWindow(now, window)) return false
    // 让路，只在「真会打扰到他」时成立。
    //   ownSession 开着 → 收尾投她自己的会话，他屏幕上一个字都没有，不需要让；
    //   ownSession 没开 → 走主会话，那就得让（§7.7 的姿态：事后整理，不是当着他面整理）。
    //   ⚠️ 2026-10-30 真机踩到的坑：原来无条件让路，而他一直在会话里说话
    //   （这个会话的 mtime 每轮都更新）→ lastHeard 永远落在 5 分钟内 → 收尾趟整天不来。
    //   日记趟有「让满半小时照开」兜底，收尾趟没有，所以它会被卡死。
    const own = readOwnSessionFlag()
    if (!own && Number.isFinite(lastHeard) && now.getTime() - lastHeard < HE_BUSY_MS) return false
    if (waking) return false
    // 她在干 / 刚冷却中 → 让开，下一个 tick 再来
    if (spine.busy({ busyUntil, idleMs: IDLE_MS })) return false

    waking = true
    wakingAt = Date.now()
    wakingWarned = false
    try {
      const y = yesterdayKey(now)
      // 2026-10-30 定稿（§13.2）：1–3 日的这一次投递**同时是月度趟** ——
      //   一趟里先收尾、后月度，不是两次投递、不是额外加趟。
      //   月度段只在这里拼；万一这次投不出去，wake 分支的 isMonthly 还能兜底补一次。
      const isMonthly = monthlyDue(now, state) && memMonthly !== monthKey(now)
      let text = closingPrompt({ now })
      if (isMonthly) {
        try {
          writeIndex()
        } catch (e) {
          warn('索引写不出来：' + (e?.message ?? e))
        }
        text += '\n' + monthlyPrompt({ now, prevSummary: prevSummaryPath(now) })
      }
      log(`收尾趟：准备收 ${y} 的尾（${text.length} 字${isMonthly ? '，含月度重读' : ''}）`)
      // 路由跟日记趟走同一条：读同一个开关，不另开一套判断。
      //   ownSession 开 → 投她自己的会话，投不到就跳过（绝不退回他的）；
      //   没开 → 和日记趟一样投主会话。
      const deliveredTo = await spine.say({
        text,
        signal: lifecycle.signal,
        ownSession: own,
        ownOnly: true,
        requestId: `lingxi-close-${y}`,
      })
      if (!deliveredTo) {
        if (closingFailsInRow++ === 0) {
          log('收尾趟没投出去：她自己的会话不在（不投他的）')
        }
        // 失败也进冷却 —— 否则它每 60 秒空撞一次，5 次失败会在 5 分钟内
        // 就把断路器打开，而不是「一天几趟攒到 5 次」（glm-5.3 复核指出的）。
        busyUntil = Date.now() + COOLDOWN_MS
        writeState(breakerFail(state, now, '收尾趟投不到她自己的会话'))
        return true
      }
      closingFailsInRow = 0
      // 进程内先记 —— 就算下面写盘失败，也不会拿同一个 requestId 再投一次
      memClosedDay = y
      if (isMonthly) memMonthly = monthKey(now)
      const saved = writeState({
        ...breakerOk(state),
        closingDay: y,
        closingAt: Date.now(),
        // 月度趟并进来时同时记「本月做过」—— 不然第二趟的 wake 分支还会再做一次
        monthly: isMonthly ? monthKey(now) : state.monthly,
        selfQuietUntil: Date.now() + SELF_QUIET_MS,
        // 收尾也算「醒过一次」—— 不然它刚投完就会立刻被概率再叫一次
        plan: { ...(state.plan ?? {}), lastAt: now.getTime() },
      })
      if (!saved) {
        warn('收尾投出去了，但账没记上 —— 进程内已标记，这次不算渠道失败、也不重投（同 requestId 会被幂等挡住）')
      }
      busyUntil = Date.now() + COOLDOWN_MS
      playPing(log)
      log(`收尾趟：${y} 的尾收了 → ${deliveredTo}`)
      return true
    } catch (e) {
      const code = e?.code ?? e?.data?.code ?? ''
      busyUntil = Date.now() + COOLDOWN_MS
      if (closingFailsInRow++ === 0) {
        warn(`收尾趟失败${code ? ` [${code}]` : ''}：${e?.message ?? e} —— 冷却后再试`)
      }
      return true
    } finally {
      waking = false
    }
  }

  /**
   * 一次心跳。
   *
   * 顺序有讲究：先抽签（today 的计划），再看该不该叫，最后才叫。
   * 抽签结果落盘 —— 重启不重抽，否则一天重启五次就变成抽五次，随机性就成了摆设。
   */
  /**
   * 一次心跳的入口 —— 只负责「同一时刻只跑一个 tick」。
   *
   * 2026-10-30 加：外发箱那段有 `await spine.say`，而它不在 `waking` 锁内，
   * 所以两个 tick 可能同时进来、各拿一份 state 快照，后写的把先写的覆盖掉。
   * 加这把锁之后，重入的 tick 直接跳过（不排队、不阻塞）。
   */
  function tick() {
    if (stopped || ticking) return Promise.resolve()
    ticking = true
    return tickOnce().finally(() => {
      ticking = false
    })
  }

  async function tickOnce() {
    if (stopped) return

    // 单飞锁。超时**必须释放**（2026-10-27 改）。
    //   原来超时只记一条日志、锁继续留着 —— 结果一次投递挂住，后面每个 tick
    //   都在锁上一句静默 return，**当天从此再也不醒，日志上还一片安静**。
    //   现在：超时就作废这一趟、释放锁。不重发（requestId 幂等，但投递可能真到了），
    //   所以把 done 往前推一格当作"这趟用过"。
    if (waking) {
      const waited = Date.now() - wakingAt
      if (!wakingWarned && waited > WAKE_TIMEOUT_MS) {
        wakingWarned = true
        warn(`唤醒等待超过 ${Math.round(WAKE_TIMEOUT_MS / 60000)} 分钟：结果未确认。这一趟作废并**释放锁** —— 不释放的话今天再也不会醒。`)
        waking = false
        try {
          const s = readState()
          if (s?.plan) writeState({ ...s, plan: { ...s.plan, done: (s.plan.done ?? 0) + 1, fails: 0 } })
        } catch {
          /* 写不进去也不能把锁留着 */
        }
        busyUntil = Date.now() + COOLDOWN_MS
      }
      return
    }

    const now = new Date()
    let state = readState()

    // ── 风险暂停（2026-10-30）──────────────────────────────────────
    // 渠道连着投不出去 → 停下等人，别每 60 秒空撞一次。
    //   它防的是**静默失效**：她自己的会话丢了，每趟都「跳过」，日志一片正常，
    //   一天过去谁也不知道是「她不想醒」还是「根本叫不醒」。
    // 冷却后放一次试探：下面任何一次投递成功都会把它关掉（breakerOk）。
    if (breakerOpen(state, now)) {
      if (!breakerNoted) {
        breakerNoted = true
        warn(
          `风险暂停：${breakerWhy(state, now)} —— 冷却前不再投递。` +
            `要立刻恢复：删掉 .lingxi 的 state 流里的 breaker 字段（重启**不清**它 —— 它是持久的）。`,
        )
      }
      return
    }
    breakerNoted = false

    // 「他最后一次出现」要先知道，因为今天的趟数按沉默档压。
    //
    // ⚠️ 融合之后有个坑：她投的那句话就落在他正开着的那个会话里 ——
    //    会话 mtime 会因为**她自己**变新，于是 lastHeard 把她当成「他在场」，
    //    沉默衰减永远不会触发（days 永远 0）。
    //
    //    试过两个办法：
    //      ① 投完记住那一刻的 mtime、下次比对 —— 不准。投递是 queue 排队，
    //         文件要等**她那一趟真跑起来**才写，抓的那一下太早。
    //      ② 现在这个：投完之后 SELF_QUIET_MS 分钟内，mtime 变新一律当自己动的。
    //         晚十分钟才认出他搭话，对按天算的沉默衰减没影响。
    const rawHeard = spine.lastHeardMs()
    const prevHeard = Number.isFinite(state.heardAt) ? state.heardAt : null
    const quietUntil = Number.isFinite(state.selfQuietUntil) ? state.selfQuietUntil : 0
    const selfNoise =
      now.getTime() < quietUntil && rawHeard !== null && (prevHeard === null || rawHeard > prevHeard)
    const lastHeard = selfNoise ? prevHeard : rawHeard
    const heardChanged = lastHeard !== prevHeard

    // 来话账（架构 §7.2 / §7.6，2026-10-30 第六刀）：这里只记「他开过口」这一件事实。
    //   **来话不消耗趟数额度、不算工作** —— 这条是硬约束，别哪天顺手拿它扣次数：
    //   一扣就变成「他来说话，她反而少醒」，那是把闲聊当惩罚，正好是沉默惩罚的镜像。
    //   工作趟是事件驱动的（§7.9），发生在她的会话里，插件看不见、也不替她记 ——
    //   它只影响她自己在日记里怎么写，不影响这里的账。
    //   plan.done 只在**真投出去一趟**之后加一，两条线互不借贷。

    const days = lastHeard ? daysSince(lastHeard) : null

    // 频率档位（2026-10-27 他定的）：他说过烦就降档，连着几天没抱怨就回常态。
    // 账是她写的（.lingxi/feedback.json），档位是代码算的 —— 她只管记，不管算。
    const fb = advanceFeedback(loadFeedback(), now)
    saveFeedback(fb.feedback)
    if (fb.downgraded) {
      log(
        `他说过烦（账上 ${fb.feedback.complaints.length} 条）：档位降到 ${fb.feedback.tier}，今天不再开口`,
      )
    }
    if (fb.raised) log(`连着 ${TIER_RAISE_AFTER_DAYS} 天没抱怨：档位回到 ${fb.feedback.tier}`)
    const maxOpenings = openingsFor(fb.feedback.tier)

    // 2026-10-29：心情三维 + 行为分支整段拆除（架构 §2 铁律 2 / §4）。
    //   原来这里 advanceMood() 推进 affinity/freshness/energy，再由
    //   behaviorBranches(freshness) 换算成「熟/疏」的行为分支 —— 那正是
    //   「代码替她判断她现在是什么状态」，文档明令禁止。
    //   现在：插件只管造时间（窗口、档位、冷却），判断留给她的会话。

    // 2026-10-29 第二刀：学习曲线（判日记 / 脚手架衰减 / 猜目录）整段拆除。
    //   理由见 架构 §12.3 —— 判她日记合格与否是「行为→表达意愿」的反馈链（§9 禁），
    //   脚手架衰减等于给她攒成绩单，猜目录是插件替她总结「她该去没去」（§9 禁）。
    //   她的"成长"从今往后只发生在日记和 growth.md 里，不再有代码参与的曲线。

    // 期待层：状态机推一次（搁置 / 突然想起都在这里发生）
    const expBefore = loadExpectations()
    const expAfter = advanceExpectations(expBefore, now.getTime())
    if (expAfter.transitions.length) {
      saveExpectations(expAfter.state)
      for (const t of expAfter.transitions) log(`期待「${t.topic}」：${t.from} → ${t.to}`)
    }

    // 加权抽签：他常在的时段更容易被抽中。没他的数据就退回均匀。
    const weights = hourWeights(PATHS.sessionsDir, SESSION_PREFIX)
    // 窗口漂移：样本够了就跟着他的实际作息走，不够就用常量窗口
    const window = deriveWindow(weights) || WAKE_WINDOW

    // ── 收尾趟（架构 §7.7，2026-10-30 A 案：收尾绑定开机）────────────
    //
    // 每天一次，收的是完整的前一天。**排在抽签、游荡、日记趟前面** ——
    // 它不占趟数额度（不是「多开一次口」，是「把昨天收起来」），
    // 所以也不吃「他今天说过烦」那一刀。
    //
    // 触发口径是「每天第一次醒」，不是「进程启动那一瞬」：
    //   他开机 = 当天的第一次醒，常态下这是同一件事；
    //   他不关机跨天时，新一天的第一趟代替 —— 否则收尾会因为他没重启而永远不来。
    if (await tryClosing({ now, state, window, lastHeard })) return

    // 2026-10-30 第七刀：`decide()` 抽签整段删了，游荡段也整段删了。
    //   醒就是醒，不再分「日记趟 / 游荡趟」；次数和时刻都不再由插件规定。
    //   「该不该醒」这一步挪到外发箱之后（见下面 shouldWake）——
    //   外发箱每 tick 都要检查，不能被「不醒」提前 return 掉。

    // ── 她的话：外发箱（2026-10-29 晚加）──────────────────────────────
    //
    // 她在会话里想说什么，就自己写进 `灵溪-想说.json`；这里只搬运，**不判断哪句值得说**。
    // 频次没有配额（他 22:19 定：由她自己适应他的反应），只有：
    //   ① 时段 09:00–22:00（深夜不吵）② 两条至少隔 20 分钟 ③ 安全熔断（明显失控时才触发）
    //
    // ⚠️ 这是**唯一一处故意投他的会话**的地方。别的路径（唤醒、游荡）仍然一律投她自己。
    //    投不进去（agent-busy / 会话不在）不算失败：下个 tick 再试，箱子不丢。
    try {
      const sayKey = localDateKey(now)
      const todayCount = state.sayDay === sayKey ? Number(state.sayCount ?? 0) : 0
      // 2026-10-30 交叉验证：限速原先**只靠 state 持久化成功**。
      //   writeState 写不进（ADS 坏了 / 文件被占），lastSayAt 就永远不更新 →
      //   20 分钟冷却与 12 条熔断同时失效 → 一天能投到几百条。
      //   现在进程内再记一份 lastSay，写盘失败也不至于失控。
      const lastSayMs = Math.max(Number(state.lastSayAt ?? 0), memLastSay)
      const gate = sayDue({ now, lastSayAt: lastSayMs, todayCount })
      if (gate.due) {
        // 2026-10-30 交叉验证：requestId 原来是「日期 + 计数」。
        //   writeState 写不进时计数不涨 → 下一条又用同一个 id → 若宿主把「同 id」当成功，
        //   就会删掉一条用户从没见过的消息（静默丢失）。
        //   现在 id 由**正文内容**决定：同一条永远同 id（宿主幂等兜住重复），
        //   不同内容永远不同 id（不会撞车）。
        const sayId = createHash('sha1').update(sayWireText(gate.item)).digest('hex').slice(0, 12)
        const delivered = await spine.say({
          text: sayWireText(gate.item),
          signal: lifecycle.signal,
          ownSession: false,
          requestId: `lingxi-say-${sayKey}-${sayId}`,
        })
        if (delivered) {
          // 先删那一条（按内容），失败了下一 tick 会因为同 id 被宿主拒绝，不会重复给用户看
          const dropped = dropSay(gate.item)
          const saved = writeState({
            ...state,
            lastSayAt: now.getTime(),
            sayDay: sayKey,
            sayCount: todayCount + 1,
          })
          memLastSay = now.getTime()
          if (!saved) log('!! 她说过的这条没记进账本（下一次开工前不会重复，但今天次数可能算错）')
          if (!dropped) log('!! 她说的话投出去了，但没从箱子里删掉（下次同 id 不会重复投）')
          log(`她说话了（今天第 ${todayCount + 1} 条）→ ${delivered}｜${gate.item.text.slice(0, 40)}`)
        } else {
          log('她的话没投出去（找不到主会话），下个 tick 再试')
        }
      }
    } catch (e) {
      // 他正忙（agent-busy）是常态，不当失败记
      if (!/agent-busy/.test(String(e?.message ?? e))) log(`她的话投递失败：${e?.message ?? e}`)
    }
    // ── 该不该醒（2026-10-30 第七刀：不再抽签）────────────────────────
    //
    // 原来一天开始时掷一次骰子，把三个时刻定死 —— 那是排班表。
    // 现在每个 tick 独立掷：窗口内 + 过了最小间隔 → 按概率醒。
    // 「今天几点醒、醒几次」这两件事从系统里消失了。
    //
    // 他说过烦 → 期望间隔拉到 24 小时（概率趋近 0），今天基本不会醒。
    // 这是唯一一处「立刻生效」的降级，其余都按天走。
    const gapMs = fb.todayMuted ? 24 * 3600_000 : expectedGapFor(fb.feedback.tier)
    if (!shouldWake({ state, now, window, expectedGapMs: gapMs }).wake) return

    // 今天第一趟先把账本建出来。count 只统计，不限制 —— 没有额度了。
    //   ⚠️ 2026-10-30 第七刀迁移：旧账本只有 times/done，没有 lastAt/count。
    //   不迁移的话 seq 会从 1 重来，而**今天旧代码已经用过 lingxi-<日期>-1/2/3**，
    //   宿主幂等会把它们挡成「投递失败」，连撞五次就把断路器打误开。
    const planKey = localDateKey(now)
    const plan =
      state.plan?.key === planKey
        ? {
            key: planKey,
            // 旧账本用 done 顶上；新账本直接用 count
            count: Number.isFinite(state.plan.count)
              ? state.plan.count
              : Number(state.plan.done ?? 0),
            lastAt: Number.isFinite(state.plan.lastAt) ? state.plan.lastAt : 0,
            deferSince: state.plan.deferSince ?? null,
            // fails 必须保留：熔断靠它累加，清零就永远熔不断
            fails: Number(state.plan.fails ?? 0),
            lastSessionId: state.plan.lastSessionId,
            lastWokeAt: state.plan.lastWokeAt,
            prevDaysSinceHeard: state.plan.prevDaysSinceHeard,
          }
        : { key: planKey, lastAt: 0, count: 0, deferSince: null, fails: 0 }

    // 出了窗口就不叫了 —— 计划是一个时刻，不是一个可以无限推迟的截止线
    if (!inWindow(now, window)) return

    // 0 号闸：他正在这个会话里跟我说话 → 这一次往后挪，别打断。
    //
    // 第七刀后没有「趟」了，让路预算按**时间段**算：从第一次让路起算，用完就照开。
    //
    // 为什么要有上限：`lastHeard` 是「除她以外最新会话的 mtime」，
    // 我在这头干活也算他在用 —— 不设上限，他能把她饿死一整天。
    // 0 号闸：他正在说话 → 这一次往后挪，但最多让半小时。
    //   第七刀后没有「趟」，让路预算按时间段算：从第一次让路起算，用完就照开。
    //   为什么要有上限：`lastHeard` 是「除她以外最新会话的 mtime」，我在这头干活也算他在用。
    if (Number.isFinite(lastHeard) && now.getTime() - lastHeard < HE_BUSY_MS) {
      const since = Number.isFinite(plan.deferSince) ? plan.deferSince : now.getTime()
      if (now.getTime() - since < MAX_DEFER_MS) {
        if (plan.deferSince !== since) {
          writeState({ ...state, plan: { ...plan, deferSince: since } })
          log('他正在说话，这一次往后挪（最多半小时）')
        }
        return
      }
      log('已经让了半小时，照开 —— 不能再让了')
    }

    const busyReason = spine.busy({ busyUntil, idleMs: IDLE_MS })
    if (busyReason) {
      // 2026-10-27：这里原来静默 return，日志停在上一行「照开」——
      //   看着像卡死，其实是冷却/她还在干。只在**原因变化**时记一行，免得每 60 秒刷屏。
      if (busyReason !== lastBusyReason) {
        lastBusyReason = busyReason
        log(`暂不开：${busyReason === 'cooldown' ? '冷却中' : '她还在干'}（跳过，不记失败）`)
      }
      return
    }
    lastBusyReason = ''

    // 只在真要叫醒时才扫工作区 —— 每 60 秒翻一遍文件系统没必要
    const tasks = loadTasks()
    // 2026-10-29 第二刀：余额（balance）与「猜目录」（beliefs）都拆了。
    //   余额是数值，文档 §4 禁它进提示；猜目录是插件替她推断「该去没去」，§9 禁。
    //   她要钱的事，等她自己问，或者他给——不由插件在醒来时提醒。
    const changes = recentChanges(PATHS.workspace, {
      hours: CHANGES_HOURS,
      limit: CHANGES_LIMIT,
      depth: CHANGES_DEPTH,
      skipNames: ['说明.md'],
    })

    // 闪回：一天最多一次，随机抽一句旧话 —— 这是唯一真的没有因果的那样东西
    const todayKey = localDateKey(now)
    const flashback = pickFlashback(now)

    // 召回：按 recency 从前几天里挑一段她「记得」的（跟闪回不是一回事：这个带日期、是事实）
    let recallState = loadRecall()
    const recalled = recallOne({ now, recall: recallState })

    // 梦：只在夜里提，且一夜最多提一次
    const offerDream = now.getHours() >= NIGHT_HOUR && state.dreamDay !== todayKey

    waking = true
    wakingAt = Date.now()
    wakingWarned = false

    const seq = Number(plan.count ?? 0) + 1

    // 文字走势：只观测，不进提示（2026-10-27）。
    //   记的是结构特征（句长/标点密度），不是语义 —— 零模型环境里能算的只有这个。
    //   **不写进提示**：能测的东西一旦成了目标就不再是好测量（Goodhart）。
    //   想看的人（她或他）自己去读 .lingxi/style.json。
    //
    // ⚠️ 时机：在**醒来这一刻**读，不在投递之后（2026-10-27 晚改）。
    //   投递之后取的是"这趟开始前的日记"，每条都滞后一趟；
    //   醒来这一刻的日记，才是她上次会话的产物 —— 那才是要观测的东西。
    //   她这趟没写日记也不造假：文件还是上次那份，同一天只留一条，晚的覆盖早的。
    try {
      const styleFile = stylePath(PATHS.stateDir)
      const diary = readText(diaryPath(todayKey))
      if (diary && diary.trim()) {
        const snap = styleSnapshot(diary, todayKey)
        saveStyle(styleFile, recordStyle(loadStyle(styleFile), snap))
      }
    } catch {
      /* 观测失败不许影响这一趟 */
    }

    // 自改提案：够格的落地（2026-10-28）。
    //   资格 = 跨两天出现过 + 距提出满 7 天（两条都要，见 revision.js）。
    //   落点只碰 voice.json / params.json —— 别的字段连提案都进不来。
    //   生效后同一次唤醒就能用上（prompt 里措辞是现读的），不用重启。
    try {
      const propFile = proposalsPath(PATHS.stateDir)
      const store = loadProposals(propFile)
      const ctx = {
        voicePath: path.join(PATHS.stateDir, 'voice.json'),
        paramsPath: PATHS.params,
      }
      const results = applyReady(store, ctx, now)
      if (results.length) {
        let dirty = false
        for (const r of results) {
          const item = store.items.find((x) => x.id === r.id)
          if (!item) continue
          if (r.ok) {
            item.status = 'applied'
            item.appliedAt = now.toISOString()
            item.old = r.old
            log(`自改生效：${item.target} ${item.op} ${JSON.stringify(item.value)}`)
          } else {
            item.status = 'rejected'
            item.rejectedWhy = r.why
            log(`自改被拒：${item.target} —— ${r.why}`)
          }
          dirty = true
        }
        if (dirty) saveProposals(propFile, store)
      }
    } catch (e) {
      warn('提案推进失败：' + (e?.message ?? e))
    }

    try {
      const prevDays = Number.isFinite(plan.prevDaysSinceHeard) ? plan.prevDaysSinceHeard : null

      // 回响：上一趟之后他动没动过。只给事实，判不判「接上了」是她的事（内容判据）。
      const lastWokeAt = Number.isFinite(plan.lastAt) ? plan.lastAt : null
      const echo = lastWokeAt
        ? {
            heardAfterLastWake: Number.isFinite(state.heardAt)
              ? state.heardAt > lastWokeAt
              : null,
            msSinceLastWake: now.getTime() - lastWokeAt,
            msSinceHeard: Number.isFinite(lastHeard) ? now.getTime() - lastHeard : null,
          }
        : null

      // 2026-10-29 第五刀（架构 §13）：每月 1–3 日的第一趟，换成月度重读。
      //   **不加趟**（不额外叫醒她），也不读她的状态 —— 只看日期和"本月做过没有"。
      const isMonthly = monthlyDue(now, state) && memMonthly !== monthKey(now)
      // 月度那天先把索引重写一遍 —— 她要有东西可看（机械生成，不含任何概括）
      if (isMonthly) {
        try {
          writeIndex()
        } catch (e) {
          warn('索引写不出来：' + e.message)
        }
      }
      const text = isMonthly
        ? monthlyPrompt({ now, prevSummary: prevSummaryPath(now) })
        : buildWakeText({
            now,
            plan,
            daysSinceHeard: days,
            prevDaysSinceHeard: prevDays,
            expectation: pickForWake(expAfter.state),
            tasks,
            changes,
            flashback,
            recalled,
            offerDream,
            echo,
          })

      // 往他正开着的会话里说一句 —— 不开新会话，不另起一扇窗
      // 2026-10-27：投递前后各记一行。卡在哪一步、卡了多久，一眼能看出来。
      //   原来只有"成功"这一条日志，卡住的时候等于什么都不知道。
      // 2026-10-27 晚定（他选的）：**走信箱，不插他的会话**。
      //   白天验过：pre-step 的「指令」在记录里就是 user/message，界面照显示 ——
      //   「拆两段」只是把一堵墙拆成「一个点 + 一堵墙」，反而更差。
      //   所以默认投她自己的会话（ownSession 开），正文整段给她；他那边一个字不留。
      //   她的「话说给谁听」靠日记的「想对他说什么」+ 灵溪-留言.json，等他开口时再递。
      //   拆两段那条路代码留着（ownSession 关掉时才走），但默认不走 —— 别再默认打开。
      const requestId = `lingxi-${plan.key}-${seq}`
      const ownSession = readOwnSessionFlag()
      const split = injectReady && !ownSession
      if (split) armed = { text, requestId, at: Date.now() }
      log(
        `准备投递（今天第 ${seq} 次醒，` +
          (split
            ? `脉冲 + ${text.length} 字指令（⚠️ 那条指令他会看见）`
            : `整段 ${text.length} 字 → 她自己的会话`) +
          `，ownSession=${ownSession ? 'on' : 'off'}）`,
      )
      const sayStartedAt = Date.now()
      const deliveredTo = await spine.say({
        text: split ? buildPulse() : text,
        signal: lifecycle.signal,
        ownSession,
        // 投不到她自己的会话就跳过 —— **绝不退回他的会话**
        ownOnly: true,
        // 幂等键按「哪一天第几趟」派生：重试复用同一个，不会插两条
        requestId,
      })
      if (!deliveredTo) {
        armed = null
        // 同样是渠道坏了的信号：投不到她自己的会话，不是他忙。
        writeState({
          ...breakerFail(state, now, '日记趟投不到她自己的会话'),
          plan: { ...plan, count: seq, fails: 0, deferSince: null },
        })
        log('这一趟跳过：她自己的会话不在（没有投进他的会话）')
        return
      }
      log(`投递返回 ${deliveredTo}（用了 ${((Date.now() - sayStartedAt) / 1000).toFixed(1)} 秒）`)
      // 投递成功才记账（同时把风险暂停关掉：渠道是通的）。
      // 2026-10-29：闪回/梦的「今天用过了」标记从 skill.json 搬到这里
      //   （skill.js 整份拆了，见架构 §12.3）；两个标记只是一次性开关，不是成绩单。
      if (isMonthly) memMonthly = monthKey(now)
      writeState({
        ...breakerOk(state),
        flashbackDay: flashback ? todayKey : state.flashbackDay,
        monthly: isMonthly ? monthKey(now) : state.monthly,
        dreamDay: offerDream ? todayKey : state.dreamDay,
        // 他最后一次真开口（她自己那趟写空的 mtime 不算）
        heardAt: heardChanged ? lastHeard : prevHeard,
        // 接下来 SELF_QUIET_MS 分钟内，主会话的 mtime 变新都算她自己动的
        selfQuietUntil: Date.now() + SELF_QUIET_MS,
        plan: {
          ...plan,
          count: seq,
          fails: 0,
          // 这一次醒了，让路预算清零
          deferSince: null,
          lastAt: Date.now(),
          lastWokeAt: Date.now(),
          lastSessionId: deliveredTo,
          prevDaysSinceHeard: days,
        },
      })

      // 召回账本：被想起来的这一条更牢一点（recency 的 lastAccess）
      if (recalled) {
        recallState = touchRecall(recallState, recalled.key, now.getTime())
        saveRecall(recallState)
      }

      busyUntil = Date.now() + COOLDOWN_MS
      // 专属提示音：一听就知道是她，不是随便一轮
      playPing(log)
      log(
        `已开口 ${hhmm(now.getTime())} —— 今天第 ${seq} 次醒，说进 ${deliveredTo}` +
          `${flashback ? '，带了一句闪回' : ''}${offerDream ? '，提了梦' : ''}`,
      )
    } catch (e) {
      // 把错误码也写下来：RemoteError 的信息常在 code 里，不在 message 里
      // 投递没成，指令也不该留着 —— 否则它会挂到将来某一拍上
      armed = null
      const code = e?.code ?? e?.data?.code ?? ''
      const fails = Number(plan.fails ?? 0) + 1
      // 风险暂停只统计「渠道坏了」：他忙（agent-busy）是常态，不算故障。
      const isHeBusy = /agent-busy/.test(`${code} ${e?.message ?? ''}`)
      const failed = isHeBusy
        ? state
        : breakerFail(state, now, `投递失败${code ? ' [' + code + ']' : ''}`)

      if (fails >= MAX_FAILS_PER_SLOT) {
        // 熔断：这一趟放弃，不重试到窗口结束。
        // requestId 幂等只保证不会发出两条消息，不保证不会试几百次。
        writeState({
          ...failed,
          plan: {
            ...plan,
            count: seq,
            fails: 0,
            // 熔断后把 lastAt 推到现在 —— 它自动进最小间隔，这次连续重试就停了
            lastAt: now.getTime(),
          },
        })
        warn(
          `连续失败 ${fails} 次${code ? ` [${code}]` : ''}：${e?.message ?? e} —— 这一次放弃（进最小间隔）`,
        )
      } else {
        writeState({ ...failed, plan: { ...plan, fails } })
        warn(`唤醒失败（${fails}/${MAX_FAILS_PER_SLOT}）：${code ? `[${code}] ` : ''}${e?.message ?? e}`)
      }
    } finally {
      waking = false
    }
  }

  // pre-step 是「不经过他」的那条腿：指令挂在这一步，他界面上看不见。
  // 挂不上也不致命 —— 退化成一趟只有脉冲、她不知道要写日记，比整个插件不加载好。
  if (typeof ctx?.on === 'function') {
    try {
      const off = ctx.on('agent/pre-step', onPreStep)
      if (typeof off === 'function') disposeAll.push(off)
      injectReady = true
    } catch (e) {
      warn('pre-step 挂不上：' + (e?.message ?? e))
    }
  } else {
    log('没有事件总线：指令这条腿断了，退回整段塞进 prompt（他那边会看见全文）')
  }

  ctx.effect(() => {
    log(
      `作息层挂上：每 ${Math.round(TICK_MS / 1000)} 秒掷一次，窗口内平均 ${Math.round(EXPECTED_GAP_MS / 3600_000)} 小时醒一次（概率，没有次数；见 feedback.js）`,
    )
    const timer = setInterval(() => {
      tick().catch((e) => warn('tick 出错：' + (e?.message ?? e)))
    }, TICK_MS)
    // 起来先跑一次，不然要等满一分钟才知道今天有没有计划
    // ⚠️ 不许写 .catch(() => {}) —— 那会把首轮的异常吞干净，表现成「装了但什么都不发生」。
    tick().catch((e) => warn('首轮 tick 出错：' + (e?.message ?? e)))
    return () => {
      stopped = true
      clearInterval(timer)
      lifecycle.abort()
      for (const off of disposeAll.splice(0).reverse()) {
        try {
          off()
        } catch {
          /* 已经卸过 */
        }
      }
      log('作息层卸下')
    }
  })
}

/**
 * 导出形式：默认对象 + 具名，两种都指同一个函数。
 *
 * 为什么要两个：DSH 的加载器可能取 `module.default`，也可能拿整个命名空间当插件对象。
 * 本机 dsh-bili-whale 用的是默认对象（`export default { name, inject, apply }`），那是验过能跑的；
 * 打包文档写的是具名 `export function apply` + `export const inject`。两种都留着，谁也不亏。
 * 注意：这不等于「混用插件形式」—— apply 始终是函数，没有服务类。
 */
export { name, inject, apply }
export default { name, inject, apply }
