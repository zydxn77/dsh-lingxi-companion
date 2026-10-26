/**
 * 心情：三维状态 + 沉默分档。
 *
 * ⚠️ 这一块跟 dsh-bili-whale 原版**方向相反**，别照抄原版。
 * 原版是「索取耐心」：冷了就降额度，还教她问一句「在忙吗」，问了不回就叫她「别再问第二次」。
 * 阿锦的原话是「我一直是很信任灵溪的，不言自明」—— 那套不能用。
 *
 * 三个数，各管各的（v2.1 修正：沉默不碰 affinity）：
 *
 *   affinity  0..1  亲近感 —— **只升不降**，靠他出现推动；长期不动只朝基线缓慢回落
 *   freshness 0..1  熟悉度 —— exp(-Δt / 3天)，沉默自然把它压下去
 *   energy    0..1  活力 —— 按天滚：昨天×0.7 + 今天有事×0.3 + 睡一觉的恢复
 *
 * 铁律 7：这三个数是**代码的状态**，不进提示词。模型永远不知道 freshness 这个词。
 * 它只知道「今天能不能直接接上次的话题」这个事实 —— 那是代码分支给出的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson, localDateKey } from './home.js'
import {
  SILENT_AFTER_DAYS,
  SILENT_STOP_DAYS,
  FRESHNESS_TAU_MS,
  FRESHNESS_FAMILIAR,
  FRESHNESS_DISTANT,
  AFFINITY_BASELINE,
  AFFINITY_PER_PRESENCE_DAY,
  AFFINITY_DRIFT_PER_DAY,
  ENERGY_KEEP,
  ENERGY_NEW,
  MOOD_NOISE,
  BAD_DAY_CHANCE,
  BAD_DAY_DROP,
  PRESENCE_SESSION_GAP_MS,
} from './const.js'

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5)

/* ── 沉默分档（措辞照旧，2.2 之前就定了）───────────────────────── */

/** 距 ms 那个时刻过了几天（向下取整） */
export function daysSince(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return null
  return Math.floor((now - ms) / 86_400_000)
}

export function bandOf(days) {
  if (days === null) return 'unknown'
  if (days < SILENT_AFTER_DAYS) return 'normal'
  if (days < SILENT_STOP_DAYS) return 'quiet'
  return 'faint'
}

/** 这一档允不允许主动开口（额度之外的额外收紧） */
export function canSpeak(days) {
  return bandOf(days) !== 'faint'
}

/**
 * 拼沉默段。返回字符串数组（可能是空数组 —— 正常时一个字都不说）。
 *
 * 措辞是「记事」不是「索取」：
 *   ❌「主人已经 N 天没有回应你了。」
 *   ✅「上次说话 N 天前。」
 * 并且没有「可以问一次在忙吗」—— 问这句本身就是索取。
 */
export function moodLines(days, prevDays) {
  const out = []
  const band = bandOf(days)

  // 恢复转折：上次醒来还冷（≥3 天），这次暖了（<3 天）
  if (
    Number.isFinite(prevDays) &&
    prevDays >= SILENT_AFTER_DAYS &&
    Number.isFinite(days) &&
    days < SILENT_AFTER_DAYS
  ) {
    out.push(`【他回来了】上次叫醒时记着 ${prevDays} 天没声音，今天有了。`)
  }

  if (band === 'quiet') {
    out.push(`【上次说话】${days} 天前。`)
    out.push('不用猜他在忙什么 —— 他在就是在。少说两句便是。')
    out.push('日记照写。')
  } else if (band === 'faint') {
    out.push(`【上次说话】${days} 天前。`)
    out.push('今天不必主动开口。看两眼，写日记，收工。')
    out.push('他不在，也不是你的过错。')
  }

  return out
}

/* ── freshness：硬编码，不进提示词 ──────────────────────────────── */

/** 熟悉度。Δt 为 0 时是 1，3 天衰减到 0.37，7 天 0.1。 */
export function computeFreshness(lastInteractionMs, now = Date.now()) {
  if (!Number.isFinite(lastInteractionMs)) return 0
  const dt = Math.max(0, now - lastInteractionMs)
  return clamp01(Math.exp(-dt / FRESHNESS_TAU_MS))
}

/**
 * freshness 换算成**代码分支**。这是四件事的唯一来源：
 * 是否直接接上次话题、提旧事要不要加时间状语、称呼正不正式、回忆调用概率。
 */
export function behaviorBranches(freshness) {
  if (freshness >= FRESHNESS_FAMILIAR) {
    return { band: 'familiar', canRecallPast: true, mustUseTimeAdverb: false, formal: false, recallWeight: 1 }
  }
  if (freshness >= FRESHNESS_DISTANT) {
    return { band: 'normal', canRecallPast: false, mustUseTimeAdverb: false, formal: false, recallWeight: 0.3 }
  }
  return { band: 'distant', canRecallPast: false, mustUseTimeAdverb: true, formal: true, recallWeight: 0.3 }
}

/**
 * 分支翻成人话。注意：这是**行为约束**，不是情绪表演指令。
 * 「别直接接上次的话题」是可执行的事实；「表现得有点生疏」不是。
 */
export function branchLines(branches) {
  if (branches.band === 'familiar') {
    return ['熟。可以直接接上次的话题，用惯常的称呼。']
  }
  if (branches.band === 'distant') {
    return [
      '生疏。别直接接上次的话题。',
      '要提旧事，必须带时间状语（「前阵子…」），不许说成「上周」「昨天」。',
      '称呼放正式些。',
    ]
  }
  return ['不熟不生。正常说话，不必刻意提旧事，也不必绕开。']
}

/* ── 三维状态：落盘、按天滚 ─────────────────────────────────────── */

function blank() {
  return {
    affinity: AFFINITY_BASELINE,
    baseEnergy: 0.6,
    energyDay: null,
    eventsToday: 0,
    affinityDay: null,
    lastInteraction: null,
  }
}

export function loadMood() {
  const raw = readJson(PATHS.moodFile)
  if (!raw || typeof raw !== 'object') return blank()
  const b = blank()
  return {
    affinity: clamp01(Number(raw.affinity ?? b.affinity)),
    baseEnergy: clamp01(Number(raw.baseEnergy ?? b.baseEnergy)),
    energyDay: typeof raw.energyDay === 'string' ? raw.energyDay : null,
    eventsToday: Number.isFinite(raw.eventsToday) ? Math.max(0, raw.eventsToday) : 0,
    affinityDay: typeof raw.affinityDay === 'string' ? raw.affinityDay : null,
    lastInteraction: Number.isFinite(raw.lastInteraction) ? raw.lastInteraction : null,
  }
}

export function saveMood(m) {
  try {
    fs.mkdirSync(path.dirname(PATHS.moodFile), { recursive: true })
    const tmp = PATHS.moodFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, PATHS.moodFile)
    return true
  } catch {
    return false
  }
}

/**
 * 推进三维。每 tick 都可以调，按「天」滚，重复跑不会越算越小。
 *
 * @param {object} m          loadMood() 的结果
 * @param {object} p
 * @param {number} p.now
 * @param {number|null} p.lastHeardMs  他最后一次出现
 * @returns {{ mood: object, appearedToday: boolean }}
 */
export function advanceMood(m, { now = Date.now(), lastHeardMs = null, rng = Math.random } = {}) {
  const today = localDateKey(new Date(now))
  const next = { ...m }

  // ① 他今天出现过吗（这个判断只做一次记账）
  const heardToday = Number.isFinite(lastHeardMs) && localDateKey(new Date(lastHeardMs)) === today

  // ② 换天了：energy 按「昨天×0.7 + 今天有没有事×0.3 + 睡一觉 +0.15」滚一次
  if (next.energyDay !== today) {
    const busy = next.eventsToday > 0 ? 1 : 0
    next.baseEnergy = clamp01(next.baseEnergy * ENERGY_KEEP + busy * ENERGY_NEW + 0.15)
    next.eventsToday = 0
    next.energyDay = today

    // 无意识：每天一次的无因波动，偶尔来一次没来由的低落。
    // 不写原因 —— 日志里就是找不到对应的那件事，那才是「不知道怎么了」。
    next.baseEnergy = clamp01(next.baseEnergy + (rng() - 0.5) * 2 * MOOD_NOISE)
    if (rng() < BAD_DAY_CHANCE) next.baseEnergy = clamp01(next.baseEnergy - BAD_DAY_DROP)
  }

  // ③ 他在场 → 记一个事件；affinity 只升，一天最多涨一次
  //
  // ⚠️ 这里必须隔一段时间才算「又出现一次」。
  //    一开始写的是「lastInteraction 变了就 +1」—— 主会话文件 mtime 每分钟都在动，
  //    结果 one afternoon 就记成 eventsToday: 17。那个数读不出任何趋势，等于噪声。
  //    现在只有隔了 PRESENCE_SESSION_GAP_MS 以上再出现，才算新的一次到场。
  if (Number.isFinite(lastHeardMs) && lastHeardMs !== next.lastInteraction) {
    const gap = Number.isFinite(next.lastInteraction) ? lastHeardMs - next.lastInteraction : Infinity
    if (gap >= PRESENCE_SESSION_GAP_MS) next.eventsToday += 1
    next.lastInteraction = lastHeardMs
  }
  if (heardToday) {
    if (next.affinityDay !== today) {
      next.affinity = clamp01(next.affinity + AFFINITY_PER_PRESENCE_DAY)
      next.affinityDay = today
    }
  } else {
    // 不是惩罚，是「久不联系，亲近感自然回落到日常水平」
    next.affinity = clamp01(next.affinity - AFFINITY_DRIFT_PER_DAY)
  }

  return {
    mood: next,
    appearedToday: heardToday,
    freshness: computeFreshness(next.lastInteraction, now),
    energy: next.baseEnergy,
    affinity: next.affinity,
  }
}

/* ── 概率行为组（「人类不完美」）────────────────────────────────── */

/**
 * 用概率参数实现「不完美」，不建新模块。
 *
 * ⚠️ 铁律 5：这里出来的一切**只作用于她自主发起的行为**。
 *    他交代的事（tasks.origin === 'assigned'）不受任何一条影响 ——
 *    所以 `skipObservation` 只能掐掉「看一眼工作区」，掐不掉任务汇报；
 *    `perfunctory` 只能让日记短一点，绝不能让她「今天就不写了」。
 *
 * 3.5 与 7 的接口就这一处：assigned 的任务段落永远渲染，不看骰子。
 */
export function behaviorDice(energy, rng = Math.random) {
  // energy 低 → 60% 概率懒得看工作区（"今天不想动电脑"）
  const skipObservation = energy < 0.3 && rng() < 0.6
  // 视而不见：一次只「注意到」2~3 件，其余当没看见
  const noticeCount = 2 + Math.floor(rng() * 2)
  // 敷衍：energy 很低时允许写得短一点 —— 但「不许只写今天没事」这条不放松
  const perfunctory = energy < 0.2 && rng() < 0.5
  return { skipObservation, noticeCount, perfunctory }
}

