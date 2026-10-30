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
import { readStream, writeStream, appendLine } from './store.js'
import path from 'node:path'
import os from 'node:os'
import { resolveProfile, resolveVoice } from './profile.js'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/**
 * 工作区：日记、档案、账本都在这儿（他能直接看见）。
 * 换机器时改这一处，或用环境变量 LINGXI_WORKSPACE 覆盖。
 */
const WORKSPACE =
  process.env.LINGXI_WORKSPACE ||
  path.join(HOME, 'OneDrive', '文档', 'deepseek-harness', 'default-workspace')

/**
 * 她是谁、她怎么说话 —— 从工作区的两份可替换文件读，缺了就用默认（灵溪）。
 *
 * 2026-10-27：这两行是把「人格」从机制里拔出来的接口。
 * 代码里不再出现具体名字；要换人只改 `.lingxi/profile.json` 与 `.lingxi/voice.json`。
 */
export const PROFILE = resolveProfile(WORKSPACE)
export const VOICE = resolveVoice(WORKSPACE)

/**
 * 现读措辞（2026-10-28）。
 *
 * 为什么不用上面那个 `VOICE` 常量：它是模块加载时算的。而她自改的措辞要写进
 * `voice.json` —— 用常量就等于**改了要重启才生效**，那「自改」就成了半截工程。
 * 这里每次现读，几毫秒的事。
 */
export function currentVoice() {
  return resolveVoice(WORKSPACE)
}

export const PATHS = {
  home: HOME,
  dshHome: DSH_HOME,
  workspace: WORKSPACE,
  /** 日记目录：一天一个 txt */
  diaryDir: path.join(WORKSPACE, PROFILE.booksDir),
  /**
   * private 分区（2026-10-29 第四刀，架构 §3.3）。
   * **插件只建目录、只把路径告诉她，永不读里面的内容。**
   * 她自己写、自己读；唤醒提示里只出现"有这么个抽屉"，不出现任何正文。
   * 路径用 private/ 子目录（方案 A，他 20:45 定的）：那是另一个抽屉，不是一个文件的后缀。
   */
  privateDir: path.join(WORKSPACE, PROFILE.booksDir, 'private'),
  /** 期待层：她还在想的事。状态机跑在代码里，内容她自己写。 */
  expectations: path.join(WORKSPACE, PROFILE.expectations),
  /** 任务账本：交代的事 vs 她起意的事，两种生命周期。 */
  tasks: path.join(WORKSPACE, PROFILE.tasks),
  /** 召回账本：哪一天的日记被想起来过几次（recency 加权用） */
  recall: path.join(WORKSPACE, '.lingxi', 'recall.json'),
  /** 白天账：主会话里的事实记录（我写、她读；只记事实不记情绪） */
  daylog: path.join(WORKSPACE, PROFILE.daylog),
  /** 梦的目录：她夜里写，不进事实层 */
  dreamDir: path.join(WORKSPACE, PROFILE.booksDir, '梦'),
  /** 账本目录 */
  stateDir: path.join(WORKSPACE, '.lingxi'),
  stateFile: path.join(WORKSPACE, '.lingxi', 'state.json'),
  /** 人设：优先用这份（别人接入人格只放这一个文件），没有才退回 AGENTS.md */
  personaCore: path.join(WORKSPACE, 'persona', 'core.md'),
  /** 她的经历流水（只追加）。2026-10-27 晚从 AGENTS.md 搬来 —— 那是她的，不是宿主配置 */
  growth: path.join(WORKSPACE, 'persona', 'growth.md'),
  /** 状态看板：她重写它（不追加）。日记是证据，看板是视图 —— 2026-10-28 */
  nowBoard: path.join(WORKSPACE, PROFILE.nowBoard),
  /** 她自改出来的参数（目前只有 diaryDetail）。跟 voice.json 分开：一个改措辞，一个改详略 */
  params: path.join(WORKSPACE, '.lingxi', 'params.json'),
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
  // 2026-10-29 第五刀：账本搬进 NTFS 数据流（架构 §8）——
  //   她 read / glob / grep 摸不到；列目录只看到一个 0 字节的 _b.dat。
  try {
    const raw = readStream(PATHS.stateDir, 'state')
    if (raw === null) return {}
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
    const body = JSON.stringify(next, null, 2) + '\n'
    if (writeStream(PATHS.stateDir, 'state', body) === 'ads') return
    const tmp = PATHS.stateFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    fs.writeFileSync(tmp, body, 'utf8')
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
    // 2026-10-29 第五刀：日志也搬进流 —— 里面有每一趟投递和失败原因（架构 §8）
    appendLine(PATHS.stateDir, 'log', `[${stamp}] ${line}`)
  } catch {
    /* 日志写不进去不该拖垮插件 */
  }
}

/**
 * 人格该由谁注入（2026-10-27 晚定，他选的第一条）。
 *
 * 背景：`AGENTS.md` 由宿主在每个会话注入一次 —— 包括她那几个 `lingxi-*` 会话。
 * 插件再从唤醒提示里塞一份，就是同一段人设说两遍：今晚实测一趟 4523 字里约 1800 字是重复的。
 *
 * 所以分工：
 *   · 宿主有人格（AGENTS.md 里有角色层）→ **'host'**，插件一个字都不注入；
 *   · 宿主没人格、但有 `persona/core.md` → **'plugin'**，插件顶上（别人接入时的那条路）；
 *   · 两样都没有 → **'none'**，她就只剩机制，唤醒提示里会明说这一点。
 *
 * @returns {'host'|'plugin'|'none'}
 */
export function personaOwner() {
  const agent = readText(PATHS.persona)
  const core = readText(PATHS.personaCore)
  return decidePersonaOwner({
    hasAgentPersona: Boolean(agent && agent.includes(PROFILE.personaMarker)),
    hasCorePersona: Boolean(core && core.trim()),
  })
}

/**
 * 判定本身（纯函数，可测）。
 *
 * 宿主优先：他那儿已经注入过一次了，插件再说一遍就是重复。
 * 只有在宿主「没人格」时，插件才拿 `core.md` 顶上。
 *
 * @param {{hasAgentPersona:boolean, hasCorePersona:boolean}} flags
 * @returns {'host'|'plugin'|'none'}
 */
export function decidePersonaOwner({ hasAgentPersona, hasCorePersona }) {
  if (hasAgentPersona) return 'host'
  if (hasCorePersona) return 'plugin'
  return 'none'
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
  // 2026-10-27（A 阶段）：先看她自己的那份。
  // 别人接入人格 = 放一个 `persona/core.md`，整份就是人设，从第一行开始读。
  // 这样「人设必须在提示词第一行」那条铁律就落在一个文件的第一行上，
  // 不再依赖从 AGENTS.md 里切段 —— 那套切法只对本机的文件结构有效。
  const core = readText(PATHS.personaCore)
  if (core && core.trim()) {
    const whole = core.replace(/\n{3,}/g, '\n\n').trim()
    return whole.length > maxChars ? whole.slice(0, maxChars) + '\n…' : whole
  }

  const raw = readText(PATHS.persona)
  if (!raw) return ''
  const marker = PROFILE.personaMarker
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
