/**
 * 她的外发箱（2026-10-29 晚加）——「她想说话」的那一半。
 *
 * 分工（他 22:19 定的三条）：
 *   ① **频次没有配额，由她自己适应**。他说过烦，她在主会话里听得到，下次就少说。
 *      这里**不设每日上限** —— 设了就变成"系统规定她几分钟能说一次"，那正好是架构禁止的那种东西。
 *      只留一个纯安全的熔断（防止文件写错导致每 60 秒刷一条），见 MAX_STREAK。
 *   ② **内容是她写的**，插件只搬运，绝不判断"哪句值得说"。
 *   ③ 卡片（把这条渲染成她的话）在客户端半边，2026-10-29 这晚还没做 ——
 *      所以现在投进主会话，他看着就是一条普通用户消息。
 *
 * 文件：`<工作区>/灵溪-想说.json`（普通文件，**她自己写**，所以她必须能读能写）
 *
 *   { "items": [ { "text": "…", "at": "2026-10-30T09:12:00+08:00", "why": "为什么想说" } ] }
 *
 * 插件读到就搬一条、搬完删掉。**写坏了不致命**：当空箱处理。
 */

import fs from 'node:fs'
import path from 'node:path'
import { PATHS, PROFILE } from './home.js'

/** 箱子文件多大就不读了（防止被写成几百 MB 卡住 tick）。 */
export const SAY_BOX_MAX_BYTES = 256 * 1024
/** 一条最多这么长（硬截断）。提示里会让她自己控制在 60 字内。 */
export const SAY_MAX_CHARS = 200
/** 提示里给她的建议长度 */
export const SAY_HINT_CHARS = 60
/** 只在这个时间段投 —— 深夜不吵他 */
export const SAY_FROM_HOUR = 9
export const SAY_TO_HOUR = 22
/** 两条之间至少隔这么久。她写得勤，插件也不该连着刷 */
export const SAY_GAP_MS = 20 * 60_000
/**
 * 安全熔断：一天投超过这么多条就停下并记一行。
 * **这不是配额** —— 它只在明显失控（比如文件写错、循环）时才触发；
 * 正常写作永远不会撞到它。撞到了是要你去查，不是让她少说。
 */
export const SAY_SAFETY_PER_DAY = 12

export function sayBoxPath() {
  return path.join(PATHS.workspace, PROFILE.sayBox)
}

/** 读箱。文件不存在 / 写坏了 → 当空箱（不抛）。 */
export function loadSayBox(file = sayBoxPath()) {
  try {
    // 2026-10-30 交叉验证提出：readFileSync 无上限，写个几百 MB 会每 60 秒卡一次事件循环
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > SAY_BOX_MAX_BYTES) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(raw?.items) ? raw.items : []
    return items
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({
        text: String(x.text).trim().slice(0, SAY_MAX_CHARS),
        at: typeof x.at === 'string' ? x.at : null,
        why: typeof x.why === 'string' ? x.why.slice(0, 120) : '',
      }))
  } catch {
    return []
  }
}

function save(file, items) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const body = JSON.stringify({ items }, null, 2) + '\n'
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file) // 原子替换：她同时在写也不会读到半个文件
    return true
  } catch {
    return false
  }
}

/** 拿走最早的一条（**先返回、不删**；投递成功了再调 dropSay） */
export function peekSay(file = sayBoxPath()) {
  return loadSayBox(file)[0] ?? null
}

/** 投递成功后删掉那一条 */
/**
 * 投递成功后删掉**那一条**。
 *
 * 2026-10-30 交叉验证指出两处，都修在这里：
 *   ① 原来是 `dropSay(0)` —— 按下标删。可 sayDue 读一次、这里又重读一次，
 *      两次之间箱子被改（她自己写、或外部动），投出去的是 A、删掉的是 B。
 *      现在按**内容**删（text + at 一起比），删错就不可能。
 *   ② 原来是直接 writeFileSync 覆盖 —— 非原子。她同时在写就会后写者胜，
 *      把她的新留言整个盖掉。现在先写 .tmp 再 rename。
 */
export function dropSay(item, file = sayBoxPath()) {
  if (!item) return false
  const items = loadSayBox(file)
  const key = (x) => `${x.text ?? ''}\u0000${x.at ?? ''}`
  const want = key(item)
  const idx = items.findIndex((x) => key(x) === want)
  if (idx < 0) return false
  items.splice(idx, 1)
  return save(file, items)
}

/**
 * 现在能不能投。
 *
 * 四条：时间段内 · 距上一条够久 · 今天没撞熔断 · 箱里有东西。
 * **不看她的情绪、不看 energy、不看"上次开口多久"** —— 那是替她判断状态。
 */
export function sayDue({ now = new Date(), lastSayAt = 0, todayCount = 0, box = null } = {}) {
  const hour = now.getHours()
  if (hour < SAY_FROM_HOUR || hour >= SAY_TO_HOUR) return { due: false, why: '不在时段' }
  if (Number.isFinite(lastSayAt) && wayTooSoon(now, lastSayAt)) return { due: false, why: '刚说过' }
  if (todayCount >= SAY_SAFETY_PER_DAY) return { due: false, why: '熔断：今天说得太多了' }
  const list = box ?? loadSayBox()
  if (!list.length) return { due: false, why: '箱子是空的' }
  return { due: true, item: list[0], why: '' }
}

function wayTooSoon(now, lastSayAt) {
  const t = typeof lastSayAt === 'string' ? Date.parse(lastSayAt) : Number(lastSayAt)
  if (!Number.isFinite(t)) return false
  return now.getTime() - t < SAY_GAP_MS
}

/**
 * 拼投递的正文。
 *
 * ⚠️ 这是**她的话**，不是唤醒提示 —— 所以不带任何指令、不带人格、不带材料。
 * 将来客户端卡片认的就是这个前缀（`[[lingxi-say]]`），用以把它渲染成她而不是用户。
 */
export const SAY_MARK = '[[lingxi-say]]'

export function sayWireText(item) {
  return `${SAY_MARK}\n${item.text}`
}
