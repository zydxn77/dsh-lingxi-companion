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
  SESSION_PREFIX,
  SESSION_TITLE_PREFIX,
  SPEAKS_PER_DAY,
  WAKE_WINDOW,
  IDLE_MS,
  COOLDOWN_MS,
  WAKE_TIMEOUT_MS,
  MAX_FAILS_PER_SLOT,
  HE_BUSY_MS,
  MAX_DEFER_MS,
  CHANGES_HOURS,
  CHANGES_LIMIT,
  CHANGES_DEPTH,
  NIGHT_HOUR,
  SELF_QUIET_MS,
} from './const.js'
import { PATHS, readState, writeState, appendLog, localDateKey } from './home.js'
import { decide, inWindow, hhmm } from './clock.js'
import { buildWakeText } from './prompt.js'
import { createSpine } from './spine.js'
import {
  daysSince,
  bandOf,
  loadMood,
  saveMood,
  advanceMood,
  behaviorBranches,
  behaviorDice,
} from './mood.js'
import { hourWeights, deriveWindow } from './presence.js'
import {
  loadExpectations,
  saveExpectations,
  advance as advanceExpectations,
  pickForWake,
} from './expectations.js'
import { loadTasks } from './tasks.js'
import { recentChanges, recentDirs } from './workspace.js'
import { readBalance, isStale, balanceLines } from './balance.js'
import { playPing } from './sound.js'
import { buildBelief, phraseBelief } from './beliefs.js'
import { pickFlashback } from './flashback.js'
import { loadRecall, saveRecall, recallOne, touchRecall } from './recall.js'
import {
  loadSkill,
  saveSkill,
  gradeYesterdayOnce,
  resolveBeliefs,
  guessedDirs,
  rememberBelief,
} from './skill.js'

// ⚠️ 一条数组写全。写成两个键（例如再补一行 inject）会被后一个覆盖 →
//    sessionController 没被注入 → 每 60 秒静默 return，不报错也不干活。
//    这个坑原版踩过，注释就留在它的源码里。
const inject = ['sessionController']
const name = 'dsh-lingxi-companion'

/**
 * 今天最多开几次口。上限是 SPEAKS_PER_DAY，但沉默档会往下压：
 *   normal → 3 · quiet → 2 · faint → 1（只写日记，不算开口）
 * 懒日由 decide 自己压到 1。
 */
function openingsFor(daysSinceHeard) {
  const band = bandOf(daysSinceHeard)
  if (band === 'faint') return 1
  if (band === 'quiet') return Math.min(2, SPEAKS_PER_DAY)
  return SPEAKS_PER_DAY
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

  let stopped = false
  let waking = false
  let wakingAt = 0
  let wakingWarned = false
  let busyUntil = 0
  const lifecycle = new AbortController()

  const spine = createSpine({
    controller: ctx.sessionController,
    sessionsDir: PATHS.sessionsDir,
    sessionPrefix: SESSION_PREFIX,
    log,
  })

  /**
   * 一次心跳。
   *
   * 顺序有讲究：先抽签（today 的计划），再看该不该叫，最后才叫。
   * 抽签结果落盘 —— 重启不重抽，否则一天重启五次就变成抽五次，随机性就成了摆设。
   */
  async function tick() {
    if (stopped) return

    // 单飞锁。超时只记一条日志：超时不等于投递失败，绝不能重发。
    if (waking) {
      if (!wakingWarned && Date.now() - wakingAt > WAKE_TIMEOUT_MS) {
        wakingWarned = true
        warn('唤醒等待超时：结果未确认，保留任务锁以避免重复投递；请检查宿主会话，勿直接重发')
      }
      return
    }

    const now = new Date()
    let state = readState()

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

    const days = lastHeard ? daysSince(lastHeard) : null
    const maxOpenings = openingsFor(days)

    // 心情三维：每 tick 推一次（按天滚，幂等，不越算越小）
    const moodAdv = advanceMood(loadMood(), { now: now.getTime(), lastHeardMs: lastHeard })
    saveMood(moodAdv.mood)
    // 熟悉度 → 行为分支。模型只看到结论，永远看不到 freshness 这个词。
    const branches = behaviorBranches(moodAdv.freshness)

    // 学习曲线：判昨天那份日记（一天一次，纯机械，不问模型）
    let skill = loadSkill()
    const graded = gradeYesterdayOnce(skill, now)
    skill = graded.skill
    if (graded.graded) {
      const g = graded.graded
      log(
        `判卷 ${g.day}：${g.ok ? '合格' : `不合格（${g.reason}）`}` +
          (g.dropped.length ? `，已撤脚手架 [${g.dropped.join(', ')}]` : '') +
          (g.restored ? '，装回一条脚手架' : ''),
      )
    }
    saveSkill(skill)

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

    const d = decide({ state, now, maxOpenings, weights, window })

    // 今天还没抽签 → 抽一串时刻，落盘，这一轮就完事
    if (d.action === 'plan') {
      state = { ...state, plan: d.plan }
      writeState(state)
      const times = d.plan.times.map((t) => hhmm(t)).join(' / ')
      const winNote = window === WAKE_WINDOW ? '' : `，窗口漂到 ${window.start}–${window.end}`
      log(
        `今天 ${d.plan.key} 定在 ${times}（${d.reason}${weights ? '，按他的在场时段加权' : '，无在场数据用均匀'}${winNote}）`,
      )
      return
    }

    if (d.action !== 'wake') return

    // 出了窗口就不叫了 —— 计划是一个时刻，不是一个可以无限推迟的截止线
    if (!inWindow(now, window)) return

    // 0 号闸：他正在这个会话里跟我说话 → 这一趟往后挪，别打断。
    //
    // ⚠️ 让路预算**按趟算，不按天算**。这里原来有个 bug：
    //    `deferSince` 存在 plan 上，一趟用完就再也没被重置 —— 于是第 1 趟让过半小时后，
    //    第 2、3 趟的 `now - since` 早就超过上限，**闸等于当天彻底失效**。
    //    现在每趟一个 `deferSlot`，换趟就重开预算：一天三趟，最多让一个半小时。
    //
    // 为什么要有上限：`lastHeard` 是「除她以外最新会话的 mtime」，
    // 我在这头干活也算他在用 —— 不设上限，他能把她饿死一整天。
    const slotIdx = d.index ?? 0
    if (Number.isFinite(lastHeard) && now.getTime() - lastHeard < HE_BUSY_MS) {
      const sameSlot = d.plan.deferSlot === slotIdx
      const since = sameSlot && Number.isFinite(d.plan.deferSince) ? d.plan.deferSince : now.getTime()
      if (now.getTime() - since < MAX_DEFER_MS) {
        if (!sameSlot || d.plan.deferSince !== since) {
          writeState({ ...state, plan: { ...d.plan, deferSlot: slotIdx, deferSince: since } })
          log(`他正在说话，第 ${slotIdx + 1} 趟往后挪（每趟最多让半小时）`)
        }
        return
      }
      log(`第 ${slotIdx + 1} 趟已经让了半小时，照开 —— 不能再让了`)
    }

    const busyReason = spine.busy({ busyUntil, idleMs: IDLE_MS })
    if (busyReason) return

    // 只在真要叫醒时才扫工作区 —— 每 60 秒翻一遍文件系统没必要
    const tasks = loadTasks()
    // 余额：读小鲸鱼已经攒好的观测，不自己调 API
    const bal = readBalance(now.getTime())
    const balLines = balanceLines(bal, { stale: isStale(bal) })
    const changes = recentChanges(PATHS.workspace, {
      hours: CHANGES_HOURS,
      limit: CHANGES_LIMIT,
      depth: CHANGES_DEPTH,
      skipNames: ['说明.md'],
    })

    // ⑨ 误解：只从「陌生的新目录」猜，置信度 < 0.5，一天最多一条
    const dirs = recentDirs(PATHS.workspace, { hours: CHANGES_HOURS })
    skill = resolveBeliefs(skill, dirs)
    const knownTopics = [
      ...expAfter.state.items.map((i) => i.topic),
      ...tasks.items.map((t) => t.topic),
      ...guessedDirs(skill),
    ]
    const beliefRaw = buildBelief({
      dirs,
      knownTopics,
      lastBeliefAt: state.lastBeliefAt,
      now: now.getTime(),
    })
    const belief = beliefRaw ? phraseBelief(beliefRaw) : null

    // 闪回：一天最多一次，随机抽一句旧话 —— 这是唯一真的没有因果的那样东西
    const todayKey = localDateKey(now)
    const flashback = skill.flashbackDay === todayKey ? null : pickFlashback(now)

    // 召回：按 recency 从前几天里挑一段她「记得」的（跟闪回不是一回事：这个带日期、是事实）
    let recallState = loadRecall()
    const recalled = recallOne({ now, recall: recallState })

    // 梦：只在夜里提，且一夜最多提一次
    const offerDream = now.getHours() >= NIGHT_HOUR && skill.dreamDay !== todayKey

    waking = true
    wakingAt = Date.now()
    wakingWarned = false

    const nth = (d.index ?? 0) + 1
    const total = d.plan.times.length

    try {
      const prevDays = Number.isFinite(d.plan.prevDaysSinceHeard)
        ? d.plan.prevDaysSinceHeard
        : null

      const text = buildWakeText({
        now,
        plan: d.plan,
        daysSinceHeard: days,
        prevDaysSinceHeard: prevDays,
        index: d.index ?? 0,
        total,
        branches,
        expectation: pickForWake(expAfter.state),
        tasks,
        changes,
        dice: behaviorDice(moodAdv.energy),
        belief,
        scaffold: skill,
        flashback,
        balanceLines: balLines,
        recalled,
        skill,
        offerDream,
      })

      // 往他正开着的会话里说一句 —— 不开新会话，不另起一扇窗
      const deliveredTo = await spine.say({
        text,
        signal: lifecycle.signal,
        // 幂等键按「哪一天第几趟」派生：重试复用同一个，不会插两条
        requestId: `lingxi-${d.plan.key}-${nth}`,
      })
      // 投递成功才记账。
      writeState({
        ...state,
        lastBeliefAt: beliefRaw ? now.getTime() : (state.lastBeliefAt ?? 0),
        // 他最后一次真开口（她自己那趟写空的 mtime 不算）
        heardAt: heardChanged ? lastHeard : prevHeard,
        // 接下来 SELF_QUIET_MS 分钟内，主会话的 mtime 变新都算她自己动的
        selfQuietUntil: Date.now() + SELF_QUIET_MS,
        plan: {
          ...d.plan,
          done: nth,
          fails: 0,
          // 这一趟开了，让路预算清零 —— 下一趟重新给半小时
          deferSlot: null,
          deferSince: null,
          lastWokeAt: Date.now(),
          lastSessionId: deliveredTo,
          prevDaysSinceHeard: days,
        },
      })

      // 技能账本：这一趟用掉的东西记账（闪回、梦、猜过的目录）
      if (flashback) skill = { ...skill, flashbackDay: todayKey }
      if (offerDream) skill = { ...skill, dreamDay: todayKey }
      if (beliefRaw) skill = rememberBelief(skill, beliefRaw.dir, now)
      saveSkill(skill)

      // 召回账本：被想起来的这一条更牢一点（recency 的 lastAccess）
      if (recalled) {
        recallState = touchRecall(recallState, recalled.key, now.getTime())
        saveRecall(recallState)
      }

      busyUntil = Date.now() + COOLDOWN_MS
      // 专属提示音：一听就知道是她，不是随便一轮
      playPing(log)
      log(
        `已开口 ${hhmm(d.plan.times[d.index ?? 0])} —— 第 ${nth}/${total} 趟，说进 ${deliveredTo}` +
          `${d.plan.skip ? '（懒日）' : ''}${flashback ? '，带了一句闪回' : ''}${offerDream ? '，提了梦' : ''}`,
      )
    } catch (e) {
      // 把错误码也写下来：RemoteError 的信息常在 code 里，不在 message 里
      const code = e?.code ?? e?.data?.code ?? ''
      const fails = Number(d.plan.fails ?? 0) + 1

      if (fails >= MAX_FAILS_PER_SLOT) {
        // 熔断：这一趟放弃，不重试到窗口结束。
        // requestId 幂等只保证不会发出两条消息，不保证不会试几百次。
        writeState({
          ...state,
          plan: {
            ...d.plan,
            done: nth,
            fails: 0,
            burned: [...(d.plan.burned ?? []), nth],
          },
        })
        warn(
          `第 ${nth}/${total} 趟连续失败 ${fails} 次${code ? ` [${code}]` : ''}：${e?.message ?? e} —— 今天这一趟放弃`,
        )
      } else {
        writeState({ ...state, plan: { ...d.plan, fails } })
        warn(`唤醒失败（${fails}/${MAX_FAILS_PER_SLOT}）：${code ? `[${code}] ` : ''}${e?.message ?? e}`)
      }
    } finally {
      waking = false
    }
  }

  ctx.effect(() => {
    log(`作息层挂上：每 ${Math.round(TICK_MS / 1000)} 秒看一眼，每天最多 ${SPEAKS_PER_DAY} 次开口`)
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
