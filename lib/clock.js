/**
 * 生物钟。
 *
 * 一句话：今天要不要醒、几点醒、醒了干什么。
 *
 * 每天的「计划」只掷一次骰子，落在 state.plan 里 —— 重启不重抽，
 * 否则一天重启五次就变成抽五次，随机性就没了。
 */
import { WAKE_WINDOW, SKIP_CHANCE, SPEAKS_PER_DAY_MAX } from './const.js'
import { localDateKey } from './home.js'

/** 'HH:MM' → 当天第几分钟。'24:00' 允许（= 1440）。 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) throw new Error(`作息窗口格式不对: ${hhmm}（要 HH:MM）`)
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 24 || min < 0 || min > 59) throw new Error(`作息窗口越界: ${hhmm}`)
  return h * 60 + min
}

/**
 * 窗口。默认取常量，也可以由在场数据漂移出来（见 presence.deriveWindow）。
 * 形如 { start: '09:00', end: '23:30' }。
 */
function win(override) {
  return override && override.start && override.end ? override : WAKE_WINDOW
}

export function windowBounds(override) {
  const w = win(override)
  const start = toMinutes(w.start)
  const end = toMinutes(w.end)
  if (end <= start) {
    throw new Error(`作息窗口 end 必须晚于 start（跨午夜的窗口暂不支持）: ${w.start}-${w.end}`)
  }
  return { start, end }
}

/** 现在在不在窗口内（半开区间） */
export function inWindow(now = new Date(), override) {
  const { start, end } = windowBounds(override)
  const mins = now.getHours() * 60 + now.getMinutes()
  return mins >= start && mins < end
}

/**
 * 段内按权重取一分钟。
 *
 * weights 是 24 格在场直方图（index 是小时）。权重只影响「段内落点」，
 * 不影响「哪一段」—— 段与段之间的间隔保证不靠它。
 */
function pickMinute(lo, hi, weights, rng) {
  const span = Math.max(1, hi - lo)
  if (!weights) return Math.floor(lo + rng() * span)

  let total = 0
  const w = new Array(span)
  for (let i = 0; i < span; i++) {
    const abs = lo + i
    w[i] = weights[Math.floor(abs / 60) % 24] ?? 1
    total += w[i]
  }
  if (!(total > 0)) return Math.floor(lo + rng() * span)

  let r = rng() * total
  for (let i = 0; i < span; i++) {
    r -= w[i]
    if (r <= 0) return lo + i
  }
  return hi - 1
}

/**
 * 给今天抽 n 个醒来时刻，升序。
 *
 * 做法：把窗口均分成 n 段，每段里取一分钟 —— 但只在段内**中间那一段**取，
 * 两头各留一个 margin，所以最坏情况下相邻两趟也至少隔 2×margin。
 *
 * weights（可选）：24 格在场直方图。他那几个小时常在这台机器上，
 * 就更容易在那几小时醒来 —— 说出口的话才有人接。
 * 传 null 退回均匀（没有他的数据时）。
 *
 * （先前那版只在段内均匀取，两头不设防：第 1 段抽到尾、第 2 段抽到头，两趟能挨在一起。
 *   注释里却写着「至少隔 window/n」，是假的。现在改成真做到了。）
 */
export function pickWakeTimes(dayStartMs, n, rng = Math.random, weights = null, override) {
  const { start, end } = windowBounds(override)
  const count = Math.max(0, Math.min(n, Math.floor((end - start) / 30) || 0))
  if (count === 0) return []
  const slot = (end - start) / count
  // 段内留白：最多 30 分钟，且不超过段的 15%，于是相邻两趟至少隔 2×margin
  const margin = Math.min(30, Math.floor(slot * 0.15))
  const out = []
  for (let i = 0; i < count; i++) {
    const lo = start + slot * i + margin
    const hi = start + slot * (i + 1) - margin
    const offsetMin = pickMinute(lo, hi, weights, rng)
    out.push(dayStartMs + Math.min(offsetMin, end - 1) * 60_000)
  }
  return out.sort((a, b) => a - b)
}

/** 单个时刻（保留给旧用例 / 懒日） */
export function pickWakeMs(dayStartMs, rng = Math.random, weights = null) {
  return pickWakeTimes(dayStartMs, 1, rng, weights)[0]
}

/** 把「某天」的零点时间戳取出来（本地时区） */
export function dayStartMs(now = new Date()) {
  const d = new Date(now.getTime())
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 决策。纯函数 —— 不写盘、不看时间以外的东西，方便自测。
 *
 * 每天的计划是一串时刻（times），按顺序一趟一趟醒。
 * `done` 是已经醒过的趟数，也是下一次开口的序号。
 *
 * @param {object} p
 * @param {object} p.state
 * @param {Date}   p.now
 * @param {number} [p.maxOpenings]  今天最多开几次口（由频率档位决定，见 feedback.js）
 * @param {number[]|null} [p.weights]  24 格在场直方图；null = 均匀
 * @returns {{ action:'plan'|'wait'|'wake'|'idle', plan?:object, index?:number, reason?:string }}
 */
export function decide({ state, now, maxOpenings = 3, rng = Math.random, weights = null, window = null }) {
  const key = localDateKey(now)
  const plan = state?.plan && state.plan.key === key ? state.plan : null

  // 今天还没抽签 → 抽一串时刻（调用方负责写盘）
  if (!plan) {
    const skip = rng() < SKIP_CHANCE
    // 懒日 / 闭嘴档只醒一次：写个日记就收工，不开口
    // 趟数由调用方给（档位），这里只兜底。
    // 2026-10-27：原来写死 `Math.min(maxOpenings, 3)` —— 他把档位调到 4 也过不去。
    const count = skip
      ? 1
      : Math.max(1, Math.min(Math.round(maxOpenings) || 1, SPEAKS_PER_DAY_MAX))
    return {
      action: 'plan',
      plan: {
        key,
        skip,
        times: pickWakeTimes(dayStartMs(now), count, rng, weights, window),
        done: 0,
        fails: 0,
        deferSlot: null,
        deferSince: null,
      },
      reason: skip ? '懒日（只写日记）' : `${count} 次`,
    }
  }

  // 旧账本（上一版只有一个 atMs / wokeAt）：今天不补，明天按新格式重来
  if (!Array.isArray(plan.times)) {
    return { action: 'idle', plan, reason: '旧格式账本，今天不补' }
  }

  const done = Number(plan.done ?? 0)
  if (done >= plan.times.length) return { action: 'idle', plan, reason: '今天该醒的都醒过了' }

  const at = plan.times[done]
  if (now.getTime() < at) return { action: 'wait', plan, index: done }

  return { action: 'wake', plan, index: done }
}

/** 人类可读的时刻，如 "09:14" */
export function hhmm(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
