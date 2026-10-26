/**
 * 召回层：从「前几天的日记」里挑一段带进唤醒提示。
 *
 * 借的是 generative_agents 的 recency 因子，但只借一个因子 —— 不做重要性评分、
 * 不做向量相关性。那两个都要额外调模型/算 embedding，为这点收益不值得。
 *
 * 三条设计要点，都是踩过才想明白的：
 *
 *   1. **衰减按天，不按小时。** 不是因为它更"温柔"，而是因为我们一天只有一份日记 ——
 *      按小时细分没有信息量。（原版 `0.995^小时` 十天后是 0.30，并没有归零；
 *      之前我在注释里说过头了，这里改正。）`0.85^天`：三天前 0.61、一周前 0.32、两周前 0.10。
 *
 *   2. **被想起过的更牢**（`hits`）。这是原版 `lastAccess` 的全部意思：
 *      反复召回的记忆留在上面，一直没人碰的往下沉。
 *      没有这一项，recency 就退化成「永远只读最近那份」。
 *
 *   3. **排除昨天。** 昨天那份的正文已经整段带进提示了，再召回一次是重复。
 *
 * 跟 flashback 的分工要分清：
 *   · 召回 = 她「记得」的，带日期，是事实
 *   · 闪回 = 完全随机，标着「不知道为什么」，不许当事实用
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson, localDateKey } from './home.js'
import { pickSentence } from './flashback.js'
import {
  RECALL_DAYS,
  RECALL_LIMIT,
  RECALL_DAILY_DECAY,
  RECALL_HIT_BOOST,
} from './const.js'

const DAY = 86_400_000

/** { [diaryKey]: { lastAccess: ms, hits: n } } */
export function loadRecall() {
  const raw = readJson(PATHS.recall)
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue
    out[k] = {
      lastAccess: Number.isFinite(v.lastAccess) ? v.lastAccess : 0,
      hits: Number.isFinite(v.hits) ? Math.max(0, v.hits) : 0,
    }
  }
  return out
}

export function saveRecall(r) {
  try {
    fs.mkdirSync(path.dirname(PATHS.recall), { recursive: true })
    const tmp = PATHS.recall + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, PATHS.recall)
    return true
  } catch {
    return false
  }
}

/** 一条候选的权重：越新越高，被想起过的再抬一点 */
export function recallWeight(daysAgo, hits = 0) {
  const base = Math.pow(RECALL_DAILY_DECAY, Math.max(0, daysAgo))
  return base * (1 + RECALL_HIT_BOOST * Math.max(0, hits))
}

/**
 * 抽一段「前几天的」记起来的东西。
 *
 * @param {object} p
 * @param {Date}   p.now
 * @param {object} [p.recall]   loadRecall() 的结果
 * @param {number} [p.limit]
 * @param {Function} [p.rng]
 * @returns {{ key: string, text: string, daysAgo: number } | null}
 */
export function recallOne({ now = new Date(), recall = {}, limit = RECALL_LIMIT, rng = Math.random }) {
  let names = []
  try {
    names = fs.readdirSync(PATHS.diaryDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(n))
  } catch {
    return null
  }
  if (!names.length) return null

  const today = localDateKey(now)
  const todayMs = Date.parse(today + 'T00:00:00')
  if (!Number.isFinite(todayMs)) return null

  // 候选：最近 RECALL_DAYS 天内，但排除今天和昨天
  const pool = []
  for (const n of names) {
    const key = n.slice(0, 10)
    if (key >= today) continue
    const daysAgo = Math.round((todayMs - Date.parse(key + 'T00:00:00')) / DAY)
    if (!Number.isFinite(daysAgo) || daysAgo < 2 || daysAgo > RECALL_DAYS) continue
    pool.push({ key, daysAgo, w: recallWeight(daysAgo, recall[key]?.hits ?? 0) })
  }
  if (!pool.length) return null

  const total = pool.reduce((a, b) => a + b.w, 0)
  if (!(total > 0)) return null

  for (let attempt = 0; attempt < Math.max(1, limit) + 2; attempt++) {
    let r = rng() * total
    let hit = pool[pool.length - 1]
    for (const c of pool) {
      r -= c.w
      if (r <= 0) {
        hit = c
        break
      }
    }
    try {
      const raw = fs.readFileSync(path.join(PATHS.diaryDir, `${hit.key}.txt`), 'utf8')
      const text = pickSentence(raw, rng)
      if (text) return { key: hit.key, text, daysAgo: hit.daysAgo }
    } catch {
      /* 读不了换一个 */
    }
  }
  return null
}

/** 记一次「想起来了」 */
export function touchRecall(recall, key, now = Date.now()) {
  const prev = recall[key] ?? { lastAccess: 0, hits: 0 }
  return { ...recall, [key]: { lastAccess: now, hits: prev.hits + 1 } }
}
