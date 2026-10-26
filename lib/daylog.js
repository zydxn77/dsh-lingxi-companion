/**
 * 白天账：主会话里的**事实**记录。
 *
 * 为什么要这本账：她醒来时只读得到昨天的日记和今天的文件变动，
 * 不知道「白天他跟我干了些什么」。所以她昨天把主会话的活记成了他干的 ——
 * 那不是她笨，是她手上真的没有这条信息。
 *
 * 分工写死在这里：
 *
 *   白天账（这本）= 事实。改了哪些文件、定了哪些事。**只记事实，不记情绪。**
 *   日记（她写）  = 经历与情绪。
 *
 * 一个灵溪，两条在场通道：这本账是通道 A（他在场）留下的痕迹，
 * 读进通道 B（她起意）的唤醒提示里。两边不合并，但互相可读。
 *
 * 谁来写：主会话里那个我。插件只读，不代写 —— 代写就又变成模板了。
 */
import { PATHS, readText } from './home.js'
import { localDateKey } from './home.js'

const HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/
const MAX_CHARS = 900

/**
 * 取今天那一节。没有就返回 null —— 没有白天账不是错，那时候他也没找我。
 *
 * @returns {string|null}
 */
export function todayLog(now = new Date(), maxChars = MAX_CHARS) {
  const raw = readText(PATHS.daylog)
  if (!raw) return null

  const key = localDateKey(now)
  const lines = raw.split('\n')
  let start = -1
  let end = lines.length

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i].trim())
    if (!m) continue
    if (start >= 0) {
      end = i
      break
    }
    if (m[1] === key) start = i + 1
  }
  if (start < 0) return null

  const body = lines
    .slice(start, end)
    .join('\n')
    .trim()
  if (!body) return null
  return body.length > maxChars ? body.slice(0, maxChars) + '\n…' : body
}
