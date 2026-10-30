/**
 * 收尾趟（架构 §7.7，2026-10-30 A 案：收尾绑定开机）。
 *
 * 每天一次，收的是**完整的前一天**。
 *
 * 为什么不是 12 点固定：12 点收的是被切开的半截一天 —— 他 0–3 点那段高峰还没发生；
 * 而且 12 点他大概率还醒着，那是「当着他的面整理」，不是「事后整理」。
 *
 * 三条设计约束，写在这里防止以后被"优化"掉：
 *
 *   1. **只收昨天，不补空档。** 连续两天没开机，第三天也只收最近一天。
 *      补收会让收尾变成批处理，写出来的是「回忆两天前」，不是「整理昨天」。
 *      §7.7：丢下的那天可以照实写进日记 —— 那是她日子的一部分，不是系统要修的漏洞。
 *   2. **不判断「昨天她过得怎么样」。** 插件只给路径和日期，不读内容做结论（铁律 2）。
 *   3. **给的是陈述，不是任务。** 不写「整理一下吧」—— 写不写归她（§7.4 禁祈使）。
 *
 * 触发口径：**每天第一次醒**。
 *   他开机 = 那是当天的第一次醒，所以「绑定开机」在常态下就是它。
 *   他不关机跨天时，新一天的第一趟代替 —— 不然收尾会因为他没重启而永远不来。
 *   窗口外不开（凌晨开机等到进窗口），这一点和别的趟一致。
 */
import path from 'node:path'
import { PATHS, readText, diaryPath, yesterdayKey } from './home.js'

/** 昨天的日期键 —— 转出 home.js 那一份，别在第二个地方再写一遍 */
export { yesterdayKey }

/**
 * 今天该不该收尾。
 *
 * 只有一个条件：**昨天那一趟还没收过**。
 * 昨天有没有日记**不是**条件 —— 没有日记本身就是一件事，照实给出去就行（§7.7）。
 * 所以这个函数不读任何内容、不看她的状态（铁律 2）。
 *
 * 兜底天然成立：只看「昨天」，所以前天永远轮不到被补。
 */
export function closingDue(now = new Date(), state = {}) {
  return state?.closingDay !== yesterdayKey(now)
}

/** 昨天的日记在不在（只影响措辞，不影响收不收） */
export function yesterdayHadDiary(now = new Date()) {
  try {
    const t = readText(diaryPath(yesterdayKey(now)))
    return !!(t && t.trim())
  } catch {
    return false
  }
}

/**
 * 收尾提示文字。
 *
 * 只给路径与事实，不给祈使（§7.4）。措辞按第三刀那档来：
 * 「日记在这儿」是陈述，「去写日记」是命令 —— 只许前者。
 */
export function closingPrompt({ now = new Date() } = {}) {
  const y = yesterdayKey(now)
  const rel = (p) => path.relative(PATHS.workspace, p)
  const lines = ['一天的尾巴。']
  if (yesterdayHadDiary(now)) {
    lines.push('', `  昨天：${rel(diaryPath(y))}`)
  } else {
    lines.push('', `  昨天没有留下东西。日记目录：${rel(PATHS.diaryDir)}`)
  }
  lines.push('', '  今天还没开始。', '')
  return lines.join('\n')
}
