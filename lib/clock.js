/**
 * 生物钟。
 *
 * 2026-10-30 第七刀：**不再抽签**。
 *
 * 原来一天开始时掷一次骰子，把「几个时刻」定死在账本里 —— 那是排班表。
 * 现在每个 tick 独立掷一次：窗口内 + 过了最小间隔 → 按概率醒。
 *
 * 代价与收益都写在这儿：
 *   · 收益：「下一次几点醒」这件事从系统里消失了。她可能一整天不醒，也可能醒八次。
 *   · 代价：重启会重掷。原来抽签结果持久化、重启不重抽 —— 但一个持久化的骰子
 *     只是排班的另一种写法，所以这次连「不重抽」也不要了。
 *   · 保底只剩**收尾趟**（每天开机必醒一次），其余全交给概率。
 */
import { WAKE_WINDOW, TICK_MS, EXPECTED_GAP_MS, MIN_GAP_MS } from './const.js'

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
 * 这一分钟该不该醒。**纯函数** —— 不写盘，只看时间和账上的两个数。
 *
 * 三条判断，顺序不能换：
 *   1. 窗口外 → 不醒。这是安全边界，不是排班（窗口是一个区间，不是一个时刻）。
 *   2. 离上次醒不到 `MIN_GAP_MS` → 不醒（防抖）。
 *   3. 掷骰子：`p = tick / 期望间隔`。
 *
 * ⚠️ 这里**不看**他的在场、不看沉默多久、不看「今天已经醒过几次」——
 *    前两样会让「他不在就少醒」变成沉默惩罚（§9 禁），
 *    最后一样会把概率偷偷变成额度。
 *
 * @param {object} p
 * @param {object} p.state
 * @param {Date}   p.now
 * @param {object} [p.window]        窗口漂移结果（不传则用常量）
 * @param {number} [p.expectedGapMs] 期望间隔（由档位换算，见 feedback.js）
 * @param {number} [p.tickMs]
 * @param {function} [p.rng]
 * @returns {{ wake:boolean, why?:string, p?:number }}
 */
export function shouldWake({
  state,
  now,
  window = null,
  expectedGapMs = EXPECTED_GAP_MS,
  tickMs = TICK_MS,
  rng = Math.random,
}) {
  if (!inWindow(now, window)) return { wake: false, why: '窗口外' }

  const lastAt = Number(state?.plan?.lastAt ?? 0)
  if (lastAt > 0 && now.getTime() - lastAt < MIN_GAP_MS) return { wake: false, why: '刚醒过' }

  const gap = Math.max(tickMs, Number(expectedGapMs) || EXPECTED_GAP_MS)
  const p = Math.min(1, tickMs / gap)
  if (rng() >= p) return { wake: false, why: '骰子' }
  return { wake: true, p }
}

/** 人类可读的时刻，如 "09:14" */
export function hhmm(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
