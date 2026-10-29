/**
 * 月度重读（架构 §13，2026-10-29 晚定）。
 *
 * 一个月一次，她把上个月合起来看一遍，然后写一份摘要 —— **唯一的固化节点**（§6.3）。
 *
 * 三条设计约束，写在这里防止以后被"优化"掉：
 *
 *   1. **只给材料，不给结论。** 索引只有两列：日期 + 那天开头的一句。
 *      不给"写了多少篇""几次不同意""本月关键词"—— 任何统计都不许进这里（§4 / §13.3）。
 *   2. **不替她挑。** 索引列出全部日期，看哪几天是她的事。代码只负责按日期取文件。
 *   3. **摘要默认 private，绝不自动公开。** 她愿意给他看，就自己另写一份 .public.md。
 *      代码永远不做"把摘要同步成可见"（§3.3 明禁）。
 *
 * 他 2026-10-29 21:05 定的三条：
 *   ① 每月 1 日（1–3 日可补，过 3 日算这个月没做）；
 *   ② 文件是 `日记/月度/YYYY-MM.md` + `YYYY-MM.public.md`；
 *   ③ 措辞选 B：「又到一个月了。想看的话，材料在这儿。」
 */

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, PROFILE, localDateKey } from './home.js'

/** 'YYYY-MM' */
export function monthKey(now = new Date()) {
  return localDateKey(now).slice(0, 7)
}

/** 上个月的键，用于找「上次那份摘要」。跨年也对（1 月 → 上年 12 月）。 */
export function prevMonthKey(now = new Date()) {
  const d = new Date(now.getTime())
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 月度目录：日记/月度/ */
export function monthlyDir() {
  return path.join(PATHS.diaryDir, '月度')
}

/** 摘要文件：private 与 public 分开，永远是两个文件 */
export function summaryPath(key, { public: isPublic = false } = {}) {
  return path.join(monthlyDir(), isPublic ? `${key}.public.md` : `${key}.md`)
}

/** 索引文件：日记/索引.txt */
export function indexPath() {
  return path.join(PATHS.diaryDir, '索引.txt')
}

/**
 * 从一篇日记里取「首行」：跳过第一行的日期，取第一行有内容的。
 * **只截 20 字，不概括** —— 概括就是替她做判断了。
 */
export function firstLine(text, chars = 20) {
  if (!text) return ''
  const lines = String(text).split('\n')
  for (const raw of lines) {
    const l = raw.trim()
    if (!l) continue
    if (/^\d{4}-\d{2}-\d{2}$/.test(l)) continue // 头一行的日期
    if (/^[—\-]{2,}/.test(l)) continue // 栏名
    return l.slice(0, chars)
  }
  return ''
}

/**
 * 扫日记目录，出索引行：`2026-10-29  开头的一句`
 *
 * 只认 `YYYY-MM-DD.txt`，跳过 private 子目录和任何不是日记的文件。
 * **按日期升序**（时间本来就有的顺序，不是"重要程度"的排序）。
 */
export function buildIndexRows({ dir = PATHS.diaryDir, max = 400 } = {}) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const days = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(n))
    .sort()
    .slice(-max)
  const rows = []
  for (const n of days) {
    const day = n.replace(/\.txt$/, '')
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, n), 'utf8')
    } catch {
      continue
    }
    const head = firstLine(text)
    if (!head) continue
    rows.push(`${day}  ${head}`)
  }
  return rows
}

/** 把索引写到 日记/索引.txt。内容是**机械生成**的，她改了也没用（下次会重写）。 */
export function writeIndex(file = indexPath()) {
  const rows = buildIndexRows()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, rows.join('\n') + (rows.length ? '\n' : ''), 'utf8')
  } catch {
    return 0
  }
  return rows.length
}

/**
 * 今天该不该做月度重读。
 *
 * 只三件事：**1–3 日** + **本月还没做过** + 有日记可读。
 * 不读她的情绪、不读 energy、不读"她上个月表现如何" —— 那是状态判断（铁律 2）。
 */
export function monthlyDue(now = new Date(), state = {}) {
  const day = now.getDate()
  if (day > 3) return false
  const key = monthKey(now)
  if (state?.monthly === key) return false
  return buildIndexRows().length > 0
}

/**
 * 月度重读的提示文字。
 *
 * ⚠️ 只给**路径**：索引文件、上次摘要文件。
 *   摘要正文一个字都不许拼进来 —— private 的内容不进任何提示（§3.3）。
 */
export function monthlyPrompt({ now = new Date(), prevSummary = null } = {}) {
  const key = monthKey(now)
  const rel = (p) => path.relative(PATHS.workspace, p)
  const lines = [
    '又到一个月了。想看的话，材料在这儿。',
    '',
    `  索引：${rel(indexPath())} —— 每天一行：日期 + 那天开头的一句。`,
    '        想看哪几天，直接读那几天的那份。',
  ]
  if (prevSummary) {
    lines.push(`  上个月那份摘要：${rel(prevSummary)}（只有你读得到）`)
  }
  lines.push(
    '',
    `  写不写、写成什么样都算。想留一份给他看的，另写 ${rel(summaryPath(key, { public: true }))}。`,
    '',
  )
  return lines.join('\n')
}

/** 上次那份摘要在哪（不存在就返回 null，不编造路径）。 */
export function prevSummaryPath(now = new Date()) {
  const p = summaryPath(prevMonthKey(now))
  try {
    return fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}
