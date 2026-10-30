/**
 * 风险暂停（断路器，2026-10-30，借 bili-humanism 的「风险暂停」）。
 *
 * 它防的是什么：**投递渠道静默坏掉**。
 *
 * 现在的失败处理是「这一趟算了」——日记趟有熔断、收尾趟有防刷屏、游荡直接作废。
 * 但三者都是**单趟**的，于是真正糟糕的那种情况没人管：
 * 她把「她自己的会话」弄丢了（ownSession 开着的配置漂了、会话被删、宿主改了路由），
 * 结果每一趟都投不出去，而日志上只是每趟一句「跳过」——看起来一切正常。
 * 一天过去，她一次都没醒，账本上 done 也没动，谁都说不清是「她不想醒」还是「根本叫不醒」。
 *
 * 所以这里只做一件事：**连着投不出去，就停下，并留下证据。**
 *
 * 三条设计约束：
 *
 *   1. **只统计「渠道坏了」的信号**，不统计他忙。
 *      `agent-busy`（他正在那个会话里说话）是常态，不是故障 —— 别的路径已经处理它。
 *      这里只认「投不到她自己的会话」这一类。
 *   2. **暂停是持久的。** 落在 state 里，重启不清零（重启正是最常见的「以为修好了」时刻）。
 *   3. **半开恢复，但不假装自动好。** 冷却后放**一次**试探：投成 → 关掉；再失败 → 重新计时。
 *      没有人工干预的入口，也没有「它自己觉得没事了」的判断 —— 两边都不许替人下结论。
 */
import { hhmm } from './clock.js'

/** 连续失败几次就停下。数字来自一次真事故的形状：一天三趟 + 游荡，5 次足够看出「整体在坏」 */
export const BREAKER_THRESHOLD = 5

/** 打开后多久放一次试探。2 小时：够他把会话重开一轮，也不至于让她一整个晚上都叫不醒 */
export const BREAKER_COOLDOWN_MS = 2 * 3600_000

/**
 * 现在是不是暂停期。
 * 纯函数：只看 state 里记的时刻和当前时间，不读任何别的东西（铁律 2）。
 */
export function breakerOpen(state, now = new Date()) {
  const at = Number(state?.breaker?.at)
  if (!Number.isFinite(at)) return false
  return now.getTime() - at < BREAKER_COOLDOWN_MS
}

/**
 * 记一次「投不出去」。连续到阈值就把断路器打开。
 *
 * 返回新的 state（调用方负责写盘）—— 这里不碰文件，方便单测。
 */
export function breakerFail(state, now = new Date(), reason = '') {
  const n = Number(state?.failStreak ?? 0) + 1
  if (n >= BREAKER_THRESHOLD) {
    return {
      ...state,
      failStreak: n,
      breaker: { at: now.getTime(), n, reason: String(reason).slice(0, 120) },
    }
  }
  return { ...state, failStreak: n }
}

/** 记一次「投出去了」：计数清零，断路器关掉。 */
export function breakerOk(state) {
  if (!state) return state
  const next = { ...state, failStreak: 0 }
  delete next.breaker
  return next
}

/** 给人（和日志）看的一句话：现在是什么状况、什么时候再试。 */
export function breakerWhy(state, now = new Date()) {
  const b = state?.breaker
  if (!b?.at) return ''
  const resumeAt = new Date(Number(b.at) + BREAKER_COOLDOWN_MS)
  return `连着投不出去 ${b.n} 次（这段：${b.reason || '未记录原因'}），已暂停到 ${hhmm(resumeAt.getTime())}`
}
