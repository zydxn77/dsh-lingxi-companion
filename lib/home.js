/**
 * 路径与状态文件。
 *
 * 三条铁律：
 *   · 日期一律用**本地时间**。绝不用 toISOString().slice(0,10) —— 那是 UTC，
 *     UTC+8 下凌晨 0 点到 7 点 59 写的东西会落到前一天。这个坑踩过，别再踩。
 *   · 状态写盘一律 .tmp + rename，别写一半断电。
 *   · 状态文件不在包目录里 —— 包用 link: 安装，重新装包不能把账本冲掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/**
 * 工作区：日记、档案、账本都在这儿（他能直接看见）。
 * 换机器时改这一处，或用环境变量 LINGXI_WORKSPACE 覆盖。
 */
const WORKSPACE =
  process.env.LINGXI_WORKSPACE ||
  path.join(HOME, 'OneDrive', '文档', 'deepseek-harness', 'default-workspace')

export const PATHS = {
  home: HOME,
  dshHome: DSH_HOME,
  workspace: WORKSPACE,
  /** 日记目录：一天一个 txt */
  diaryDir: path.join(WORKSPACE, '灵溪日记'),
  /** 他的档案（老格式：自由 markdown，只当 identity 级永不衰减） */
  dossier: path.join(WORKSPACE, '灵溪-关于他.md'),
  /** 他的档案现行格式：JSON，带 tier 和 updated，三级衰减见 lib/dossier.js */
  dossierJson: path.join(WORKSPACE, '灵溪-关于他.json'),
  /** 期待层：她还在想的事。状态机跑在代码里，内容她自己写。 */
  expectations: path.join(WORKSPACE, '灵溪-期待.json'),
  /** 任务账本：交代的事 vs 她起意的事，两种生命周期。 */
  tasks: path.join(WORKSPACE, '灵溪-任务.json'),
  /** 技能账本：脚手架衰减、工具失败、猜过的东西（学习曲线落点） */
  skill: path.join(WORKSPACE, '.lingxi', 'skill.json'),
  /** 召回账本：哪一天的日记被想起来过几次（recency 加权用） */
  recall: path.join(WORKSPACE, '.lingxi', 'recall.json'),
  /** 白天账：主会话里的事实记录（我写、她读；只记事实不记情绪） */
  daylog: path.join(WORKSPACE, '灵溪-白天账.md'),
  /** 梦的目录：她夜里写，不进事实层 */
  dreamDir: path.join(WORKSPACE, '灵溪日记', '梦'),
  /** 心情三维：affinity / freshness / energy。数值，不进提示词。 */
  moodFile: path.join(WORKSPACE, '.lingxi', 'mood.json'),
  /** 账本目录 */
  stateDir: path.join(WORKSPACE, '.lingxi'),
  stateFile: path.join(WORKSPACE, '.lingxi', 'state.json'),
  /** 人设：宿主自己的角色层 */
  persona: path.join(DSH_HOME, 'AGENTS.md'),
  /** 会话记录目录（用来判断他最近在不在） */
  sessionsDir: path.join(DSH_HOME, 'sessions'),
}

/** 本地日期键 YYYY-MM-DD */
export function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 昨天同一时刻的本地日期键 */
export function yesterdayKey(d = new Date()) {
  const t = new Date(d.getTime())
  t.setDate(t.getDate() - 1)
  return localDateKey(t)
}

export function diaryPath(key) {
  return path.join(PATHS.diaryDir, `${key}.txt`)
}

/** 读状态。文件坏了不抛 —— 当作空的重新来（账本坏了不该让插件起不来）。 */
export function readState() {
  try {
    const raw = fs.readFileSync(PATHS.stateFile, 'utf8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    return obj
  } catch {
    return {}
  }
}

/** 原子写状态 */
export function writeState(next) {
  try {
    fs.mkdirSync(PATHS.stateDir, { recursive: true })
    const tmp = PATHS.stateFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, PATHS.stateFile)
    return true
  } catch {
    return false
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function exists(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

/**
 * 落盘日志。
 *
 * 为什么需要它：插件跑在 DSH 的 Electron 主进程里，`console.warn` 进了黑洞 ——
 * 出了问题只能靠猜（第一次装就是靠猜出「requestId 必填」的，代价是一个来回）。
 * 有这张 `.lingxi/lingxi.log`，下一次失败能直接看见错误码。
 *
 * 不设上限，但每天写得极少（几次 tick 一条），不必轮转。
 */
export function appendLog(line) {
  try {
    fs.mkdirSync(PATHS.stateDir, { recursive: true })
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    fs.appendFileSync(path.join(PATHS.stateDir, 'lingxi.log'), `[${stamp}] ${line}\n`, 'utf8')
  } catch {
    /* 日志写不进去不该拖垮插件 */
  }
}

/**
 * 人设：从 ~/.dsh/AGENTS.md 里截「角色层」那一段，取前 N 字。
 *
 * 为什么单独挑「角色层」而不是整份：整份 34KB，前面还有生成说明和 DSH 侧使用要点，
 * 全塞进唤醒提示会把这 3000 字的预算浪费在机制说明上。
 *
 * 为什么还要截到「下一个顶级标题」为止：角色层后面紧跟「# 长期记忆」，
 * 那是给他看的账本（还款、项目索引、变更记录），不是她醒来第一眼该读的东西。
 * 唤醒提示里只该有：身份 / 性格 / 说话风格 / 行为准则 / 示例。
 */
export function readPersona(maxChars) {
  const raw = readText(PATHS.persona)
  if (!raw) return ''
  const marker = '# 角色层'
  const at = raw.indexOf(marker)
  let body = at >= 0 ? raw.slice(at) : raw

  if (at >= 0) {
    // 找下一个顶级标题。'\n# ' 不会误中 '## '（那第三个字符是 '#'，不是空格）。
    const end = body.indexOf('\n# ', 1)
    if (end > 0) body = body.slice(0, end)
  }

  const cut = body.replace(/\n{3,}/g, '\n\n').trim()
  return cut.length > maxChars ? cut.slice(0, maxChars) + '\n…' : cut
}

/** 档案：他喜欢什么、在做什么。没有就是没有，不编。 */
export function readDossier(maxChars) {
  const raw = readText(PATHS.dossier)
  if (!raw) return ''
  const t = raw.trim()
  return t.length > maxChars ? t.slice(0, maxChars) + '\n…' : t
}
