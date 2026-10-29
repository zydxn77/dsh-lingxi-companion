/**
 * 日期算术（2026-10-29 按架构 §4 大幅拆除后的残骸）。
 *
 * ⚠️ 这里**曾经**是心情三维 + 行为分支：
 *   affinity（亲近度）· freshness（熟悉度）· energy（精力）
 *   → behaviorBranches(freshness)：是否直接接上次话题、提旧事要不要加时间状语、称呼正不正式、回忆权重
 *   → behaviorDice(energy)：懒日概率、观察件数、详略
 *   → moodLines(days)：按沉默天数写「少说两句便是」「今天不必主动开口」
 *
 * 全删了。理由（架构 §2 铁律 2 / §4 / §9）：
 *   **任何代码替她判断「她现在是什么状态」即违规。**
 *   「按沉默天数决定她少说几句」既是状态判断，也是沉默惩罚；
 *   moodLines 里那些「少说两句」更是祈使任务，违反 §7.4。
 *
 * 留下什么：只有 daysSince —— 纯减法，不带判断，用来算日期差。
 * 调度要用的「上次成功开口时间 → 冷却」按 §11.1 走，不在这里。
 */

/** 距 ms 那个时刻过了几天（向下取整） */
export function daysSince(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return null
  return Math.floor((now - ms) / 86_400_000)
}
