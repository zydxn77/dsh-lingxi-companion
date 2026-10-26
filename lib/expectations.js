/**
 * 期待层：她还在想的事。
 *
 * 分界线（铁律 7）：**内容她写，状态机跑代码。**
 *   · 写什么、关心到什么程度 —— 她自己在会话里改这个 JSON
 *   · 什么时候从「进行中」掉到「搁置」、什么时候「突然想起」—— 代码判，不靠提示词
 *
 * 为什么要状态机：「前阵子不是说想做那个功能吗，后来怎么没下文了」这种体验，
 * 提示词保证不了长期连续性 —— 模型不知道「前阵子」是几天。状态机知道。
 *
 * 利息衰减是**算出来的**，不是每次 tick 减一遍：
 *   effective = base × DECAY^距上次更新的天数
 * 这样重复跑也不会越算越小（幂等）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson } from './home.js'
import {
  EXPECT_MAX,
  EXPECT_STUCK_SHELVE_DAYS,
  EXPECT_ACTIVE_SHELVE_DAYS,
  EXPECT_INTEREST_DECAY,
  EXPECT_INTEREST_FLOOR,
  EXPECT_INTEREST_BUMP,
  EXPECT_MAIN_RATIO,
} from './const.js'

/** 进行中 / 卡住 / 搁置 / 突然想起 / 已了结 */
export const STAGES = ['active', 'stuck', 'shelved', 'remembered', 'resolved']

const STAGE_LABEL = {
  active: '进行中',
  stuck: '卡住',
  shelved: '搁置',
  remembered: '突然想起',
  resolved: '已了结',
}

const DAY = 86_400_000

function daysSince(iso, now) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now - t) / DAY))
}

/** 读。文件坏了就当空的 —— 期待层坏了不该让插件起不来。 */
export function loadExpectations() {
  const raw = readJson(PATHS.expectations)
  if (!raw || !Array.isArray(raw.items)) return { items: [] }
  return {
    items: raw.items
      .filter((x) => x && typeof x.topic === 'string' && x.topic.trim())
      .map((x) => ({
        topic: String(x.topic).trim(),
        baseInterest: clamp01(Number(x.baseInterest ?? x.interest ?? 0.5)),
        stage: STAGES.includes(x.stage) ? x.stage : 'active',
        note: typeof x.note === 'string' ? x.note : '',
        updated: typeof x.updated === 'string' ? x.updated : new Date().toISOString(),
        related: Array.isArray(x.related) ? x.related.filter((r) => typeof r === 'string') : [],
      })),
  }
}

export function saveExpectations(s) {
  try {
    fs.mkdirSync(path.dirname(PATHS.expectations), { recursive: true })
    const tmp = PATHS.expectations + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, PATHS.expectations)
    return true
  } catch {
    return false
  }
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5)

/** 当前利息（算出来的，不落盘） */
export function effectiveInterest(item, now = Date.now()) {
  const d = daysSince(item.updated, now)
  return Math.max(EXPECT_INTEREST_FLOOR, item.baseInterest * Math.pow(EXPECT_INTEREST_DECAY, d))
}

/** 相关文件动过了吗（比上次更新还新） */
export function relatedChanged(item, now = Date.now()) {
  if (!item.related.length) return false
  const last = Date.parse(item.updated)
  if (!Number.isFinite(last)) return false
  for (const rel of item.related) {
    try {
      const abs = path.isAbsolute(rel) ? rel : path.join(PATHS.workspace, rel)
      if (fs.statSync(abs).mtimeMs > last) return true
    } catch {
      /* 文件没了不算「动了」 */
    }
  }
  return false
}

/**
 * 推进状态机。纯逻辑 + 一次文件时间检查，幂等 —— 跑多少次结果一样。
 *
 * @returns {{ state: object, transitions: {topic:string,from:string,to:string}[] }}
 */
export function advance(state, now = Date.now()) {
  const transitions = []
  const items = state.items.map((item) => {
    const d = daysSince(item.updated, now)
    let stage = item.stage
    let baseInterest = item.baseInterest

    // 卡住一周 → 搁置
    if (stage === 'stuck' && d > EXPECT_STUCK_SHELVE_DAYS) stage = 'shelved'
    // 进行中两周没动静 → 搁置
    else if (stage === 'active' && d > EXPECT_ACTIVE_SHELVE_DAYS) stage = 'shelved'
    // 搁置的东西，相关文件又动了 → 突然想起
    else if (stage === 'shelved' && relatedChanged(item, now)) {
      stage = 'remembered'
      baseInterest = clamp01(baseInterest + EXPECT_INTEREST_BUMP)
    }

    if (stage !== item.stage) {
      transitions.push({ topic: item.topic, from: item.stage, to: stage })
    }
    return { ...item, stage, baseInterest }
  })

  // 超过上限：先丢已了结的，再丢利息最低的
  let kept = items
  if (kept.length > EXPECT_MAX) {
    kept = [...kept]
      .sort((a, b) => {
        if (a.stage === 'resolved' && b.stage !== 'resolved') return 1
        if (b.stage === 'resolved' && a.stage !== 'resolved') return -1
        return effectiveInterest(b, now) - effectiveInterest(a, now)
      })
      .slice(0, EXPECT_MAX)
  }

  return { state: { items: kept }, transitions }
}

/** 唤醒时要提的那一条。80% 主线，20% 突然想起别的。 */
export function pickForWake(state, rng = Math.random) {
  const live = state.items.filter((it) => it.stage !== 'shelved' && it.stage !== 'resolved')
  if (!live.length) return null
  const sorted = [...live].sort((a, b) => effectiveInterest(b) - effectiveInterest(a))
  if (sorted.length === 1) return sorted[0]
  if (rng() < EXPECT_MAIN_RATIO) return sorted[0]
  const rest = sorted.slice(1)
  return rest[Math.floor(rng() * rest.length)]
}

/**
 * 把一条期待翻成提示词里的一句话。
 *
 * 注意：这里给的是**素材**，不是指令 —— 说什么、怎么提，她自己决定。
 * 「搁置」态不出现在唤醒提示里：它要么相关文件动了自动变回「突然想起」，要么就继续躺着。
 */
export function describe(item) {
  const label = STAGE_LABEL[item.stage] ?? '进行中'
  const note = item.note ? `——${item.note}` : ''
  if (item.stage === 'remembered') {
    return `${item.topic}（${label}，好一阵没下文了${note}）`
  }
  if (item.stage === 'stuck') {
    return `${item.topic}（${label}${note}）`
  }
  return `${item.topic}（${label}${note}）`
}
