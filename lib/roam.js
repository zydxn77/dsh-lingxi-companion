/**
 * 游荡趟（2026-10-28 他说「这样做吧」）。
 *
 * 为什么要有它：她原来一天只醒三趟，每趟都必须写日记 ——
 * **那是打卡，不是活着。** 一个只在被点名时必须交作业的东西，不会游荡。
 *
 * 游荡也借自 Coopanion 那只鲸鱼，但只借一半：
 *   它借的是「常驻 + 自己动 + 你能看见」；
 *   我们做不了「在屏幕上走」（那是客户端插件的活），
 *   只做「她真的自己去逛了一趟，并且留下脚印」。
 *
 * 三条规矩（和日记趟完全分开，不占那三次额度）：
 *   ① 一天 1–2 趟，落在他清醒的窗口内随机；
 *   ② 唤醒文字很短，**不要求写日记**，允许什么都不做；
 *   ③ 逛完自己往 `灵溪-游荡.md` 记一行 —— 插件只叫醒，不代写。
 *
 * 硬上限在 `读片.mjs`（一天 3 条），不在这里。这里只管「给不给她一段没人要作业的时间」。
 */
import { WAKE_WINDOW } from './const.js'
import { PROFILE } from './home.js'

/** 一天最多几趟游荡 */
export const ROAM_MAX_PER_DAY = 2

/** 第二趟被抽中的概率（第一趟必有） */
export const ROAM_SECOND_CHANCE = 0.5

/** 游荡记录文件名（她写，只追加）。名字归 profile，机制里不出现具体人名 */
export const ROAM_LOG = PROFILE.roamLog

/** 'HH:MM' 或小时数 → 当天 0 点起的毫秒 */
function windowMs(v) {
  if (typeof v === 'number') return Math.round(v * 3600000)
  const [h, m] = String(v).split(':').map(Number)
  return ((h || 0) * 60 + (m || 0)) * 60000
}

/**
 * 今天该游荡几次、大概什么时候。
 *
 * 只抽一次，落在 state.plan.roam 上（跟日记趟的 times 并列，互不干扰）。
 * 抽的时刻是「今天内随机的一个点」，不是精确安排 —— 游荡本来就该是散的。
 */
export function planRoamDay(now, window = WAKE_WINDOW) {
  const startMs = windowMs(window.start)
  const endMs = windowMs(window.end)
  const span = Math.max(60000, (endMs - startMs) * 0.9)
  const count = 1 + (Math.random() < ROAM_SECOND_CHANCE ? 1 : 0)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const times = []
  for (let i = 0; i < count; i++) {
    // 窗口里随机，避开首尾各 10 分钟 —— 别贴着开窗/关窗那一刻
    times.push(midnight + startMs + 600000 + Math.floor(Math.random() * span))
  }
  times.sort((a, b) => a - b)
  return { key: localKey(now), times, done: 0 }
}

function localKey(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

/**
 * 到点了吗。
 * 返回 { due, index, total } —— index 是第几趟（0 起），total 是今天计划几趟。
 */
export function roamDue(plan, now) {
  if (!plan || !Array.isArray(plan.times) || !plan.times.length) return { due: false }
  const done = Number(plan.done ?? 0)
  if (done >= plan.times.length) return { due: false }
  const at = plan.times[done]
  if (now.getTime() < at) return { due: false }
  return { due: true, index: done, total: plan.times.length }
}

/** 这一趟用掉了 */
export function markRoamDone(plan, index) {
  return { ...plan, done: index + 1 }
}

/** 给提示用的路径说明（她要知道往哪写） */
export function roamLogHint() {
  return ROAM_LOG
}
