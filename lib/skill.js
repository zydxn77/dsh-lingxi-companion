/**
 * 技能账本：学习曲线的落点。
 *
 * 核心矛盾：她每天开新会话、零上下文。所以学习**只能在文件里**，而且必须**可测**。
 *
 * 两条路：
 *
 *   1. **脚手架衰减** —— 判她昨天的产物，连续合格就撤掉一条提示。
 *      学得越好，教得越少。跟人一样。
 *   2. **踩坑记下来** —— 工具失败、猜错了什么，下次唤醒时点名。
 *
 * 铁律：**判卷必须机械**。一旦让 LLM 判「今天写得好不好」，她就会开始表演给考官看。
 * 所以这里全是字符串检查和计数，一个字都不问模型。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson, localDateKey, readText, diaryPath } from './home.js'
import {
  SCAFFOLD_STEPS,
  SCAFFOLD_OK_TO_DROP,
  SCAFFOLD_MISS_TO_RESTORE,
  DIARY_MIN_CHARS,
  BELIEF_RESOLVE_DAYS,
} from './const.js'

const blank = () => ({
  ok: 0,
  miss: 0,
  /** 已经撤掉的脚手架名（在 SCAFFOLD_STEPS 里） */
  dropped: [],
  /** 最近一次判卷的日期，一天只判一次 */
  gradedDay: null,
  /** 最近一次判卷的结论，给日志用 */
  lastGrade: null,
  /** { 命令: 失败次数 } */
  toolFails: {},
  /** [{ dir, at, wrong }] 猜过的东西 */
  beliefs: [],
  /** 最近一次闪回的日期（一天最多一次） */
  flashbackDay: null,
  /** 最近一次写梦的日期 */
  dreamDay: null,
})

export function loadSkill() {
  const raw = readJson(PATHS.skill)
  if (!raw || typeof raw !== 'object') return blank()
  const b = blank()
  return {
    ok: Number.isFinite(raw.ok) ? raw.ok : 0,
    miss: Number.isFinite(raw.miss) ? raw.miss : 0,
    dropped: Array.isArray(raw.dropped) ? raw.dropped.filter((x) => SCAFFOLD_STEPS.includes(x)) : [],
    gradedDay: typeof raw.gradedDay === 'string' ? raw.gradedDay : null,
    lastGrade: raw.lastGrade ?? null,
    toolFails:
      raw.toolFails && typeof raw.toolFails === 'object' && !Array.isArray(raw.toolFails)
        ? Object.fromEntries(
            Object.entries(raw.toolFails).filter(([, n]) => Number.isFinite(n)),
          )
        : {},
    beliefs: Array.isArray(raw.beliefs)
      ? raw.beliefs.filter((x) => x && typeof x.dir === 'string').map((x) => ({
          dir: x.dir,
          at: typeof x.at === 'string' ? x.at : new Date().toISOString(),
          wrong: x.wrong === true,
        }))
      : [],
    flashbackDay: typeof raw.flashbackDay === 'string' ? raw.flashbackDay : null,
    dreamDay: typeof raw.dreamDay === 'string' ? raw.dreamDay : null,
  }
}

export function saveSkill(s) {
  try {
    fs.mkdirSync(path.dirname(PATHS.skill), { recursive: true })
    const tmp = PATHS.skill + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, PATHS.skill)
    return true
  } catch {
    return false
  }
}

/* ── 判卷：纯机械，问不了模型 ─────────────────────────────────── */

/**
 * 从一份日记里切出某一节。
 *
 * 为什么要这个：日记现在是**两个作者**共用的 ——
 *   `—— 总结 ——`  她写（判卷只看这一节）
 *   `—— 白天 ——`  主会话的我写（事实流水账，不参与判卷）
 * 不切开，我这半天改代码的字数会替她判及格。
 *
 * @param {string} text
 * @param {string} name  如 '总结' / '白天'
 * @returns {string|null} 没有这一节就 null
 */
export function extractSection(text, name) {
  if (!text) return null
  const src = String(text)
  const marker = new RegExp(`——\\s*${name}\\s*——`)
  const m = marker.exec(src)
  if (!m) return null
  const rest = src.slice(m.index + m[0].length)
  // 切到下一个「—— X ——」为止
  const next = /——\s*[^—\n]{1,8}\s*——/.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/**
 * 判一份日记写得行不行。
 *
 * 只看「总结」那一节 —— 白天账是主会话写的，不是她的水平。
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function gradeDiary(text) {
  if (text === null || text === undefined) return { ok: false, reason: '没有这份日记' }
  const body = String(text).trim()
  if (!body) return { ok: false, reason: '文件是空的' }

  const section = extractSection(body, '总结')
  if (section === null) return { ok: false, reason: '缺「总结」段' }

  // 去掉小标题、分隔线、清单符号之后还剩多少字
  const meat = section
    .replace(/^#.*$/gm, '')
    .replace(/[～~\-—=\s·*]/g, '')
  if (meat.length < DIARY_MIN_CHARS) return { ok: false, reason: `总结只有 ${meat.length} 字，太短` }
  if (/^(今天没事|无事|没什么事|今天没什么事)$/.test(meat)) return { ok: false, reason: '只写了「今天没事」' }
  return { ok: true, reason: '' }
}

/**
 * 判**昨天**那份，一天只判一次。
 *
 * 为什么不判今天的：唤醒的时候今天的还没写完。
 *
 * @returns {{ skill: object, graded: null | { ok: boolean, reason: string, day: string, dropped: string[], restored: string } }}
 */
export function gradeYesterdayOnce(skill, now = new Date()) {
  const today = localDateKey(now)
  if (skill.gradedDay === today) return { skill, graded: null }

  const y = new Date(now.getTime())
  y.setDate(y.getDate() - 1)
  const yKey = localDateKey(y)
  const raw = readText(diaryPath(yKey))
  // 昨天压根没有文件 → 那天她没醒，不算她的错，不记 miss
  if (raw === null) return { skill: { ...skill, gradedDay: today }, graded: null }

  const g = gradeDiary(raw)
  const next = { ...skill, gradedDay: today, lastGrade: { day: yKey, ...g } }

  if (g.ok) {
    next.ok = skill.ok + 1
    next.miss = 0
    // 连续合格够数 → 撤掉一条（按 SCAFFOLD_STEPS 的顺序，从后往前撤最新的多余提示）
    if (next.ok >= SCAFFOLD_OK_TO_DROP) {
      const remaining = SCAFFOLD_STEPS.filter((s) => !skill.dropped.includes(s))
      if (remaining.length) {
        next.dropped = [...skill.dropped, remaining[0]]
        next.ok = 0
      }
    }
  } else {
    next.miss = skill.miss + 1
    next.ok = 0
    if (next.miss >= SCAFFOLD_MISS_TO_RESTORE && skill.dropped.length) {
      // 装回最近撤掉的那条
      next.dropped = skill.dropped.slice(0, -1)
      next.miss = 0
    }
  }

  return {
    skill: next,
    graded: {
      ok: g.ok,
      reason: g.reason,
      day: yKey,
      dropped: next.dropped,
      restored: next.miss === 0 && !g.ok && skill.dropped.length > next.dropped.length,
    },
  }
}

/** 这条脚手架还在不在（true = 还要提醒她） */
export function scaffoldOn(skill, name) {
  return !skill.dropped.includes(name)
}

/* ── 工具失败账本 ─────────────────────────────────────────────── */

/** 最该提的那几条失败命令 */
export function toolFailLines(skill, limit = 3) {
  const entries = Object.entries(skill.toolFails)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
  if (!entries.length) return []
  return [
    '上次这些没跑通，别再原样撞一次：',
    ...entries.map(([cmd, n]) => `· ${cmd}（${n} 次）`),
    '',
  ]
}

/* ── 误解闭环 ─────────────────────────────────────────────────── */

/** 猜过的目录名（不再猜第二次） */
export function guessedDirs(skill) {
  return skill.beliefs.map((b) => b.dir)
}

/** 记一条猜测 */
export function rememberBelief(skill, dir, now = new Date()) {
  return {
    ...skill,
    beliefs: [...skill.beliefs, { dir, at: now.toISOString(), wrong: false }].slice(-12),
  }
}

/**
 * 把「过了 N 天那目录再没动过」的猜测判成猜错。
 *
 * 这是她唯一一条「由错误变成经验」的路径 —— 有了它，误解才不是噪声，是成长。
 *
 * @param {{name:string,mtime:number}[]} dirs 当前工作区顶层目录
 */
export function resolveBeliefs(skill, dirs, now = Date.now()) {
  const byName = new Map(dirs.map((d) => [d.name, d.mtime]))
  let changed = false
  const beliefs = skill.beliefs.map((b) => {
    if (b.wrong) return b
    const at = Date.parse(b.at)
    if (!Number.isFinite(at) || now - at < BELIEF_RESOLVE_DAYS * 86_400_000) return b
    const mt = byName.get(b.dir)
    // 目录没了，或者一直没再动过 → 那次大概是顺手建的
    if (mt === undefined || mt <= at) {
      changed = true
      return { ...b, wrong: true }
    }
    return b
  })
  return changed ? { ...skill, beliefs } : skill
}

/** 提示里那句话：「上次猜那个，猜错了」 */
export function wrongBeliefLines(skill, limit = 2) {
  const wrong = skill.beliefs.filter((b) => b.wrong).slice(-limit)
  if (!wrong.length) return []
  return [
    '（上次你猜错过）',
    ...wrong.map((b) => `· 你曾猜「${b.dir}」是件新事，后来没下文 —— 大概是顺手建的。`),
    '  提旧事的时候别把猜的当事实说。',
    '',
  ]
}
