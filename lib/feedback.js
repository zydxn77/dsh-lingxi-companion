/**
 * 频率档位：**他记在嘴上，她记在账上，代码算档位。**
 *
 * 2026-10-27 他定的。原话：「没有上限时，靠什么挡住她一晚上刷你十次 ——
 * 首先我烦了就会跟她说，之后再经过学习就会稳定下来。」
 *
 * 所以这里不设死数，只做三件事：
 *
 *   1. **读一本账**（`.lingxi/feedback.json`）。她听到他说烦了，就在 `complaints`
 *      里加一行 `{ "day": "YYYY-MM-DD", "said": "他的原话" }`。
 *   2. **折算成档位**。每一条新抱怨降一档（只在第一次见到时降 —— 用 `applied`
 *      记住算过几条，重复跑不会越降越低）；降到底 `TIER_MIN`。
 *   3. **跟着时间回升**。连着 `TIER_RAISE_AFTER_DAYS` 天没抱怨 → 升回一档，
 *      **且只回升到常态 `TIER_DEFAULT` 为止**。高于常态的档位只能他明说——
 *      否则"三天没人抱怨"会一路涨到 `TIER_MAX`，那是自动加速，不是学习。
 *
 * 他抱怨的当天：`todayMuted = true`，当天的剩余趟数直接作废（见 index.js）。
 * 这是唯一一处"立刻生效"的地方 —— 都说过烦了，还等到明天才收敛就没意义了。
 *
 * ⚠️ 档位是数字，**不进提示词**（设计取舍第 7 条：数值只进代码分支）。
 *   提示里只告诉她「他说烦了就记账，别自己算」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson, localDateKey } from './home.js'
import {
  TIER_DEFAULT,
  TIER_MIN,
  TIER_MAX,
  TIER_RAISE_AFTER_DAYS,
  SPEAKS_PER_DAY_MAX,
  EXPECTED_GAP_MS,
} from './const.js'

/** 账本位置（运行时数据，不在包里 —— 重装不冲掉）。 */
export function feedbackPath() {
  return path.join(PATHS.stateDir, 'feedback.json')
}

function clampTier(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return TIER_DEFAULT
  return Math.max(TIER_MIN, Math.min(SPEAKS_PER_DAY_MAX, Math.round(v)))
}

/**
 * 读账。坏文件不致命：退回归一档都不能要的默认值，别让一次手滑把频率搞乱。
 *
 * @returns {{tier:number, applied:number, complaints:Array<{day:string,said?:string}>, lastTierDay:string|null}}
 */
export function loadFeedback() {
  let raw = null
  try {
    raw = readJson(feedbackPath())
  } catch {
    raw = null
  }
  const complaints = Array.isArray(raw?.complaints)
    ? raw.complaints
        .filter((c) => c && typeof c.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.day))
        .map((c) => ({ day: c.day, said: typeof c.said === 'string' ? c.said.slice(0, 200) : '' }))
        .slice(-50)
    : []
  return {
    tier: clampTier(raw?.tier),
    applied: Math.max(0, Math.min(Number(raw?.applied) || 0, complaints.length)),
    complaints,
    lastTierDay: typeof raw?.lastTierDay === 'string' ? raw.lastTierDay : null,
  }
}

/** 落盘。先写 .tmp 再 rename —— 跟项目里其他账本一个做法。 */
export function saveFeedback(f) {
  const file = feedbackPath()
  const next = {
    tier: clampTier(f?.tier),
    applied: Math.max(0, Number(f?.applied) || 0),
    complaints: Array.isArray(f?.complaints) ? f.complaints.slice(-50) : [],
    lastTierDay: typeof f?.lastTierDay === 'string' ? f.lastTierDay : null,
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 写不进去就当这次没记 —— 下一轮还会再算一次，不致命 */
  }
  return next
}

/**
 * 从昨天往回数，连续几天没有抱怨。数到一条抱怨就停。
 *
 * @param {Date} now
 * @param {Array<{day:string}>} complaints
 * @returns {number}
 */
export function quietDaysBefore(now, complaints) {
  const bad = new Set((complaints ?? []).map((c) => c.day))
  let n = 0
  for (let i = 1; i <= TIER_RAISE_AFTER_DAYS + 2; i += 1) {
    const d = new Date(now.getTime())
    d.setDate(d.getDate() - i)
    if (bad.has(localDateKey(d))) break
    n += 1
  }
  return n
}

/**
 * 把账折成今天的档位。每个 tick 都可以调 —— 幂等。
 *
 * @param {object} f  loadFeedback() 的结果
 * @param {Date} now
 * @returns {{feedback:object, downgraded:number, raised:boolean, todayMuted:boolean, quietDays:number}}
 */
export function advanceFeedback(f, now) {
  const today = localDateKey(now)
  const complaints = Array.isArray(f?.complaints) ? f.complaints : []
  let tier = clampTier(f?.tier)
  let applied = Math.max(0, Number(f?.applied) || 0)

  // 新抱怨：只在第一次见到时降档，重复跑不会越降越低
  let downgraded = 0
  while (applied < complaints.length) {
    tier = Math.max(TIER_MIN, tier - 1)
    applied += 1
    downgraded += 1
  }

  const todayMuted = complaints.some((c) => c.day === today)

  // 每跨一天看一次回升
  let raised = false
  let lastTierDay = typeof f?.lastTierDay === 'string' ? f.lastTierDay : null
  const quietDays = quietDaysBefore(now, complaints)
  if (lastTierDay !== today) {
    lastTierDay = today
    // 只回常态，不回上限 —— 见文件头
    if (quietDays >= TIER_RAISE_AFTER_DAYS && tier < TIER_DEFAULT) {
      tier += 1
      raised = true
    }
  }

  return {
    feedback: { tier, applied, complaints, lastTierDay },
    downgraded,
    raised,
    todayMuted,
    quietDays,
  }
}

/**
 * 记一条抱怨。她自己写文件也行，但这个方法让"记"有个明确形状。
 *
 * 同一天记两次只算一条 —— 一晚上抱怨五遍不该降五档，那是惩罚不是学习。
 *
 * @param {object} f loadFeedback() 的结果
 * @param {Date} now
 * @param {string} said 他的原话
 * @returns {object} 新的账（未落盘）
 */
export function recordComplaint(f, now, said = '') {
  const day = localDateKey(now)
  const complaints = Array.isArray(f?.complaints) ? [...f.complaints] : []
  if (!complaints.some((c) => c.day === day)) {
    complaints.push({ day, said: String(said).slice(0, 200) })
  }
  return { ...f, complaints: complaints.slice(-50) }
}

/**
 * 档位 → 期望醒来间隔（2026-10-30 第七刀）。
 *
 * 原来档位是「一天几次」，第七刀把次数删了，所以它改成倍率：
 *   档位 3（常态）= `EXPECTED_GAP_MS`（3 小时）
 *   档位 2        = 4.5 小时
 *   档位 1        = 9 小时
 *
 * **它只拉长间隔，不保证这个间隔里一定醒** —— 概率是概率，额度是额度，两者别混。
 * 高于常态的档位也认（他明说要更勤），但同样只是缩短间隔。
 */
export function expectedGapFor(tier) {
  const t = clampTier(tier)
  return Math.round((EXPECTED_GAP_MS * TIER_DEFAULT) / t)
}
