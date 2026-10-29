/**
 * 信箱 —— 她对他说的话，存在这里；他下次开口时由主会话的人读给他。
 *
 * 2026-10-27 加。为什么不再直接 prompt 进他会话：
 *   原来的做法是 `controller.prompt({mode:'queue'})` 往他正开着的会话里塞一条。
 *   查清楚之后有两条硬伤：
 *     1. **塞进去的是「叫醒她的指令」**（【到点了】…写日记…别只写"今天没事"），
 *        不是「她对他说的话」—— 他看见会莫名其妙。
 *     2. **额度按"入队"扣，不按"送达"扣**。入队之后他再发一句话，
 *        那条排队的 prompt 很可能被顶掉，票却已经扣了（2026-10-27 13:12 那趟就是这样）。
 *
 *   改成信箱之后：她说的话落成一个文件，**不打断、不抢额度**，他下次来的时候看到。
 *   这就是他自己那份设计里写的「推送 = 留言，开机看到，不是实时通知」。
 *
 * 数据来源不需要她多写一行：直接从日记的「想对他说什么」那一栏收。
 * 那一栏本来就是她对他说的话；空着就不收（空本身是信号，不该变成一条空留言）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, PROFILE, readText, localDateKey } from './home.js'
import { extractSection } from './text.js'

/** 信箱最多留多少条 —— 攒太多他也不会看，看到最新几条就够。 */
export const MAIL_KEEP = 20
/** 一条留言最多多少字 —— 她的日记可能写很长，信箱只留一句。 */
export const MAIL_MAX_CHARS = 400

export function mailboxPath() {
  return path.join(PATHS.workspace, PROFILE.inbox)
}

function load() {
  try {
    const raw = fs.readFileSync(mailboxPath(), 'utf8')
    const j = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return { items: Array.isArray(j?.items) ? j.items : [], lastSeenAt: Number(j?.lastSeenAt) || 0 }
  } catch {
    return { items: [], lastSeenAt: 0 }
  }
}

function save(box) {
  const items = box.items
    .slice()
    .sort((a, b) => Number(b.at) - Number(a.at))
    .slice(0, MAIL_KEEP)
  const file = mailboxPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ items, lastSeenAt: Number(box.lastSeenAt) || 0 }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return items
}

/** 未读的，新的在前。 */
export function readUnread() {
  return load().items.filter((x) => !x.readAt)
}

/** 全部，新的在前。 */
export function readAll() {
  return load().items
}

/**
 * 收一封：从某天的日记「想对他说什么」里取。
 *
 * 幂等：同一段话重复收不会插两条（按 dayKey + 正文前 80 字认）。
 * 那一栏空着 / 没有日记 / 内容是「没有」→ 不收，返回 null。
 */
export function harvest(dayKey = localDateKey(), now = Date.now()) {
  const file = path.join(PATHS.diaryDir, `${dayKey}.txt`)
  const raw = readText(file)
  if (raw === null) return null
  const said = extractSection(raw, '想对他说什么')
  if (!said) return null
  const text = String(said).replace(/\s+/g, ' ').trim().slice(0, MAIL_MAX_CHARS)
  if (!text || /^(没有|无|今天没有)[。.！!]?$/.test(text)) return null

  const box = load()
  const dedupe = `${dayKey}|${text.slice(0, 80)}`
  if (box.items.some((x) => x.dedupe === dedupe)) return null

  const item = { id: `m${now}`, at: now, dayKey, text, dedupe, readAt: null }
  box.items.push(item)
  save(box)
  return item
}

/** 标记已读。传 id 数组；不传就把所有未读标掉。 */
export function markRead(ids) {
  const box = load()
  const set = Array.isArray(ids) && ids.length ? new Set(ids) : null
  const at = Date.now()
  let n = 0
  for (const x of box.items) {
    if (x.readAt) continue
    if (set && !set.has(x.id)) continue
    x.readAt = at
    n += 1
  }
  box.lastSeenAt = at
  save(box)
  return n
}

/** 给提示用的一行（主会话读给他听时可以直接用）。 */
export function renderMail(item) {
  const d = item.dayKey ? item.dayKey.slice(5) : ''
  return `${d} 她留了一句：「${item.text}」`
}
