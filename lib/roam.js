/**
 * 游荡的痕迹文件（2026-10-28 加，2026-10-30 第七刀大幅缩水）。
 *
 * 原来这里管「今天游荡几趟、几点」—— 那是第二张排班表。
 * 第七刀把调度整个搬走了：醒不醒不再分「日记趟 / 游荡趟」，
 * 全交给 `clock.shouldWake` 的概率。planRoamDay / roamDue / markRoamDone 都删了。
 *
 * 剩下的是这条线里唯一还成立的部分：**她逛完自己往这儿追一行**。
 * 插件只提供路径，不代写、不统计、不检查她写没写。
 */
import { PROFILE } from './home.js'

/** 游荡记录文件名（她写，只追加）。名字归 profile，机制里不出现具体人名 */
export const ROAM_LOG = PROFILE.roamLog

/** 给提示用的路径说明（她要知道往哪写） */
export function roamLogHint() {
  return ROAM_LOG
}
