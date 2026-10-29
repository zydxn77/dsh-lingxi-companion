/**
 * 文字走势：只观测，不设阈（2026-10-27 晚）。
 *
 * 起因：她要"成长"，但插件是零模型的纯 JS —— 语义、情绪、主题分布都算不了。
 * 能算的只有**文本的结构特征**：句子多长、标点多密。这两样跟表达复杂度强相关，
 * 而且**无需她配合**（直接读日记）。
 *
 * ⚠️ 只观测，不进提示，不当闸门。理由：
 *   **能测的东西一旦变成目标，就不再是好测量。** 把"平均句长"写进唤醒提示，
 *   她就会对着指标写 —— 这是 Goodhart's law，不是我在多虑。
 *   所以这里只落盘，想看的人（她或他）自己去读。
 *
 * 数据形状（`.lingxi/style.json`，一天一条，保留最近 60 天）：
 * ```json
 * { "history": [ { "key": "2026-10-27", "at": "...", "chars": 912,
 *                  "sentences": 34, "avgSentence": 26.8, "punctuation": 0.118 } ] }
 * ```
 */
import fs from 'node:fs'
import path from 'node:path'

/** 句子切分：中英文句末标点都算。空段丢掉。 */
export function splitSentences(text) {
  if (!text) return []
  return String(text)
    .split(/[。！？!?…]+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 平均句长（字）。没有句子就是 0。 */
export function avgSentenceLength(text) {
  const parts = splitSentences(text)
  if (!parts.length) return 0
  const total = parts.reduce((n, s) => n + s.length, 0)
  return Math.round((total / parts.length) * 10) / 10
}

/**
 * 标点密度：标点数 / 总字数。
 *
 * 用"密度"不用"个数" —— 她某天写得多，标点自然多，个数会骗人。
 */
export function punctuationDensity(text) {
  const raw = String(text ?? '')
  const chars = raw.replace(/\s+/g, '')
  if (!chars.length) return 0
  const marks = chars.match(/[，、；：。！？…—～·「」『』（）()《》〈〉“”‘’"'!?.,;:]/g)
  const n = marks ? marks.length : 0
  return Math.round((n / chars.length) * 1000) / 1000
}

/**
 * 一份快照。
 *
 * @param {string} text 那一趟读到的日记正文
 * @param {string} key  本地日期键（YYYY-MM-DD）
 * @param {string} at   时间戳 ISO
 */
export function styleSnapshot(text, key, at = new Date().toISOString()) {
  const body = String(text ?? '')
  const chars = body.replace(/\s+/g, '').length
  const sentences = splitSentences(body).length
  return {
    key,
    at,
    chars,
    sentences,
    avgSentence: avgSentenceLength(body),
    punctuation: punctuationDensity(body),
  }
}

/**
 * 记一条。同一天只留一条（后来的覆盖先前的 —— 日记是连着写的，晚的那条更完整）。
 * 保留最近 `limit` 天。
 *
 * @param {Array} history 现有历史
 * @param {object} snapshot 新快照
 * @param {number} [limit]
 */
export function recordStyle(history, snapshot, limit = 60) {
  const list = Array.isArray(history) ? history.filter((x) => x && typeof x.key === 'string') : []
  const rest = list.filter((x) => x.key !== snapshot.key)
  const next = [...rest, snapshot].sort((a, b) => String(a.key).localeCompare(String(b.key)))
  return next.slice(-limit)
}

/**
 * 走势：最近一条 vs 窗口内更早的平均。
 *
 * 只给"变长/变短/基本没动"和两个数，**不给建议** —— 建议会被她当成目标。
 *
 * @param {Array} history
 * @param {number} [window] 往回看几条（不含最新那条）
 * @returns {{dir:'longer'|'shorter'|'flat', from:number, to:number, delta:number}|null}
 */
export function styleTrend(history, window = 7) {
  const list = (Array.isArray(history) ? history : [])
    .filter((x) => x && Number.isFinite(x.avgSentence) && x.avgSentence > 0)
    .slice()
  if (list.length < 2) return null
  const latest = list[list.length - 1]
  const earlier = list.slice(Math.max(0, list.length - 1 - window), list.length - 1)
  if (!earlier.length) return null
  const avg = earlier.reduce((n, x) => n + x.avgSentence, 0) / earlier.length
  const from = Math.round(avg * 10) / 10
  const to = latest.avgSentence
  const delta = Math.round((to - from) * 10) / 10
  // 差 2 字以内当没动 —— 否则每次都像是"变了"
  const dir = Math.abs(delta) < 2 ? 'flat' : delta > 0 ? 'longer' : 'shorter'
  return { dir, from, to, delta }
}

/** 落盘位置（跟别的账本一起，在 .lingxi 下）。 */
export function stylePath(stateDir) {
  return path.join(stateDir, 'style.json')
}

/** 读历史；坏了就当空。 */
export function loadStyle(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(raw?.history) ? raw.history : []
  } catch {
    return []
  }
}

/** 写回。先 .tmp 再 rename —— 跟项目里其他账本一个做法。 */
export function saveStyle(file, history) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ history }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
