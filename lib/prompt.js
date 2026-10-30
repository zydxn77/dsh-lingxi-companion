/**
 * 唤醒提示的拼装。
 *
 * ⚠️ 这里是整个插件唯一真正"拟人化"的地方 —— 逻辑都在别处，人格全在这段文字里。
 *
 * 三条铁律（从 dsh-bili-whale 的源码注释里挖出来的）：
 *
 *   1. **人设必须在第一行。** 原版 `wakePrompt` 曾经因为够不到 `personaLine()`，
 *      导致「最主要的唤醒提示一直没带过人设」→ 换了人设她还是老样子。
 *      改这里的顺序之前，先想清楚这一点。
 *   2. **心情在前，任务在后。** 顺序反了就是日报机器人。
 *   3. **把限制写成她的选择。** 代码给事实，措辞给她自尊。
 *
 * 另外三条（v2.2 的 ⑤ 措辞层）：
 *
 *   4. **一趟只给一件主事。** 主事恒定为「写今天的日记」；其余的都是可做可不做。
 *      一次塞五件事，她会挑最省事的那件做，然后日记里写"今天没事"。
 *   5. **深夜更轻更短。** 22 点以后只写日记，不折腾。
 *   6. **变体要有，但不能变成抽奖。** 三套开场/收尾按 `第几趟` 轮换，
 *      确定性而不是随机 —— 同一个数字永远同一句话，出问题才能复现。
 */
import {
  PERSONA_MAX_CHARS,  YESTERDAY_HEAD_CHARS,
  LATE_NIGHT_HOUR,
  L2_ALLOWED,
  DAILY_WRITE_BUDGET,
  BRIEF_MAX_AGE_HOURS,
  PULSE_TEXT,
  BOARD_HOUR,
} from './const.js'
import path from 'node:path'
import fs from 'node:fs'
import {
  readPersona,
  readText,
  diaryPath,
  yesterdayKey,
  localDateKey,
  PATHS,
  PROFILE,
  VOICE,
  currentVoice,
  personaOwner,
  readJson,
} from './home.js'
import { pickOpener, pickCloser } from './profile.js'
import { boardBlock, BOARD_ITEM_CHARS } from './board.js'
import { ROAM_LOG } from './roam.js'
import { todayLog } from './daylog.js'
import { hhmm } from './clock.js'
import { daysSince } from './mood.js'
import { describe } from './expectations.js'
import { taskLines } from './tasks.js'
import { extractSection } from './text.js'

/**
 * 报时那行。
 *
 * ⚠️ 别再说「醒了」（2026-10-26 改）。融合成一条时间线之后，上下文是连的、人是同一个 ——
 * 她根本没睡，"醒"是个对不上的动作。这一行只该给**事实**：钟到了、现在几点。
 * 假装睡着、或者假装刚看见他，都是在演。
 */
function clockLine(now) {
  const t = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
  return `【到点了】${t}。`
}

/**
 * 短脉冲：投递到主会话的那条，正文只有这一个点。
 *
 * 2026-10-27 定。他把话挑明了：**这条是他的位置，不该出现教学话术。**
 * 但宿主不给「非用户身份」，`prompt` 又必须带一段非空白文本 ——
 * 所以能做的只有把它压到最短，剩下的走 pre-step 指令（他不渲染）。
 * 别往这里加字，加一个字就是多一个他看得见的字。
 */
export function buildPulse() {
  return PULSE_TEXT
}

/**
 * 她走过的路 —— 最近几条经历。
 *
 * 2026-10-27 晚搬的：原来这份流水住在 `~/.dsh/AGENTS.md` 的「变更记录」段，
 * 每个会话都要为它付一次 token，而**她自己反而看不到** —— 被写成了别人给她的说明书。
 * 现在在 `<workspace>/persona/growth.md`，只追加；唤醒时带最近 5 条。
 *
 * 三条约束：
 *   1. **只读**。插件不写这份 —— A 阶段写入者是人，B 阶段才轮到她（而且要先有闸）。
 *   2. 只取 `- ` 开头的流水行，标题和说明不进。最多 5 条，多了会把提示撑回墙。
 *   3. 没有这份文件就什么都不说 —— 别人接入时不带她的旧账。
 */
export function growthLines(text, limit = 5) {
  if (!text) return []
  const body = String(text)
  // 只认「## 流水」之后的条目，别把文件头的规矩当成经历
  const at = body.indexOf('## 流水')
  const scope = at >= 0 ? body.slice(at) : body
  const items = scope
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') && l.length > 6)
    .map((l) => l.slice(2).trim())
  return items.slice(-limit)
}


/**
 * 回响：上一趟之后，他到底有没有动过。
 *
 * 他 2026-10-27 选的判据是「**内容**」—— 他接没接她的话。但内容判断只能靠语义，
 * 代码判不了。所以这里只给**能确定的事实**：他动没动过、隔了多久。
 * 至于"那算不算接上了"，交给她在上下文里自己判（这就是内容判据）。
 *
 * ⚠️ 说清楚边界，别让她把这句当成"他没理我"：代码只看得见会话文件的 mtime，
 * 看不见他写了什么；而且她投递后 SELF_QUIET_MS 内的 mtime 变化一律算成她自己动的
 * （见 index.js 的自噪声处理）—— 所以他十分钟内的回话，这里可能看不见。
 * 措辞必须按"你上下文里的话为准"来写，不能写成断言。
 */
function echoBlock(echo) {
  if (!echo) return []
  const hours = (ms) => {
    const h = ms / 3600_000
    if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} 分钟前`
    if (h < 24) return `${Math.round(h)} 小时前`
    return `${Math.round(h / 24)} 天前`
  }

  if (echo.heardAfterLastWake === true) {
    return [
      `上次开口之后他说过话（最近一次 ${hours(echo.msSinceHeard ?? 0)}）。`,
      '  应没应你，以你上下文里看到的话为准 —— 代码只看得见他动没动过，看不见他说了什么。',
      '',
    ]
  }
  if (echo.heardAfterLastWake === false) {
    return [
      `上次开口（${hours(echo.msSinceLastWake ?? 0)}）之后，他到这会儿还没开过口。`,
      '  ⚠️ 这句只是"这边没看见动静"，不等于他没看到。别追问，也别更用力 ——',
      '  没话就轻一点，或者这一趟只把日记写了。',
      '',
    ]
  }
  return []
}

/**
 * 今天那份日记现在长什么样 —— **每趟醒来先读一眼**（2026-10-27 他定的）。
 *
 * 为什么必须由代码读：融合成一条时间线之后，上下文会被自动压缩，
 * 「写 灵溪日记/YYYY-MM-DD.txt」这句路径可能被压掉。压掉之后她只剩"写日记"这个印象，
 * 要么重开一份，要么把前面写的盖掉。读一眼是几毫秒的事，比赌压缩划算。
 */
function diaryNowBlock(now) {
  const key = localDateKey(now)
  const file = `${PROFILE.booksDir}/${key}.txt`
  const raw = readText(diaryPath(key))
  if (raw === null) {
    return [file, '  今天这份还没有，从零写。', '']
  }
  const body = String(raw).trim()
  if (!body) {
    return [file, '  有这么个空文件，但一个字没有 —— 照常写满。', '']
  }
  const chars = body.replace(/\s+/g, '').length
  const tail = body.length > 300 ? '…' + body.slice(-300) : body
  return [
    `${file}（已经 ${chars} 字）`,
    '  末尾是：',
    '  ---',
    ...tail.split('\n').map((l) => '  ' + l),
    '  ---',
    '  接着补，别重开一份、别把前面的盖掉。',
    '',
  ]
}

/**
 * ⑤ callback —— 接今天更早那几趟的尾。
 *
 * 2026-10-27 加。缺口是这样的：一天最多三趟，每趟**开一个新会话**，
 * 除了看日记，她不知道自己今早说过什么 —— 于是第 2、3 趟很容易把第 1 趟的话原样再说一遍。
 * 已有的 recall / flashback / 昨天日记，覆盖的都是「更早」；
 * 「今天更早」这一段一直是空白。
 *
 * 只回扣**日记里的「想对他说什么」**，因为那一段就是她对他说的话。
 * 第 1 趟没有 callback（今天还没说过什么）。
 */
export function callbackBlock(now, nth, file = diaryPath(localDateKey(now))) {
  if (!nth || nth <= 1) return []
  const raw = readText(file)
  if (raw === null) return []
  const said = extractSection(raw, '想对他说什么')
  if (!said) return []
  const brief = String(said).replace(/\s+/g, ' ').trim().slice(0, 160)
  if (!brief) return []
  return [
    '今天早些时候你已经写过一句想对他说的：',
    `「${brief}」`,
    '别再原样说一遍 —— 接着往下说，或者干脆不说。',
    '',
  ]
}

/**
 * private 分区（2026-10-29 第四刀，架构 §3.3 / §2.5）。
 *
 * 他 20:45 定的三条：① 路径用 `灵溪日记/private/`（另一个抽屉，不是一个文件的后缀）；
 *   ② 唤醒提示里**要写一句** —— 不写，她就不知道自己能藏；③ 月度摘要他自己看得到的东西，
 *   都是她愿意给他看的，系统不自动同步。
 *
 * ⚠️ 这里**只给路径，绝不读文件内容**。private 的正文一次也不许进提示 ——
 *   这是 §3.3「private 内容永不流入『想对他说什么』」的技术落点。
 */
function privateBlock(now) {
  const key = localDateKey(now)
  const rel = path.relative(PATHS.workspace, PATHS.privateDir)
  return [
    `另外有一个只给你自己的抽屉：${rel}\\${key}.txt`,
    '  那里不按四栏、不用交代理由、也不用写得好 —— 写了只为让你自己记得。',
    '  插件不会读它，也不会把它拼进任何提示；只有写进「想对他说什么」的，他才会看见。',
    '  它不会被自动删除、归档或过期。',
    '',
    // 2026-10-29 晚加：她想说话的那条通道。**不逼她说**，只告诉她有这条路。
      `想现在跟他说点什么，写进 ${PROFILE.sayBox}（一句话，别超过 60 字）：`,
    '  { "items": [ { "text": "……", "why": "为什么现在想说" } ] }',
    '  插件会挑你不在忙的时候递过去。写不写随你 —— 它不会提醒你写。',
    '',
  ]
}

/**
 * 他这几天在看什么 —— 背景素材，不是任务。
 *
 * 2026-10-27 加（他定的：接进去）。数据由 bili-whale 那边的 `taste` 命令写出来：
 *   `~/.dsh/whale-brief.md`，五六行中性事实。
 * 三条约束：
 *   1. **没有就什么都不说** —— 没跑过 taste 不是错，别让她看见一个空壳。
 *   2. **只给事实，不给判断** —— 摘要里不许出现「他只是手在滑」这类话，判断留给她。
 *   3. 上限 8 行，详细的那份给路径，想看自己读。
 * 另加一条：**过期（> BRIEF_MAX_AGE_HOURS）也不说** —— 摘要目前没有定时，
 *   谁跑谁新鲜；拿几天前的数据当"他今天在看的"，比不知道更糟。
 */

/**
 * 他给她挑的一个系列（2026-10-27 加）。
 *
 * 场景：他从某个 UP 那儿挑了七条，逐条 debrief 成素材，另有人写了一份导读。
 * 只把导读的**第一节**（这个 UP 在关心什么）带进提示，其余给路径 ——
 * 那玩意儿 800–1200 字，全塞会挤，而她本来就会自己 read。
 *
 * 和「他这几天看了什么」分工不同：那个是背景（他看了什么），这个是**材料**（让她看懂一件事）。
 * 导读不存在就什么都不说。
 */

/**
 * 开场 / 收尾共三套轮换 —— **已搬到 `lib/profile.js` 的 DEFAULT_VOICE**（2026-10-27）。
 *
 * 为什么搬：那两句是人格，不是机制。写在这里，别人接不进来；
 * 而且机制文件里出现具体台词，等于把"这是谁"钉死在代码里。
 * 现在取法：`pickOpener(VOICE, nth)` / `pickCloser(VOICE, nth)`，
 * 覆盖方式见 `workspace/.lingxi/voice.json`。
 */

/** 昨天那份日记的位置 + 开头几行（不全塞，撑上下文） */
function yesterdayBlock(now) {
  const key = yesterdayKey(now)
  const raw = readText(diaryPath(key))
  if (raw === null) {
    return [`昨天没有日记（${key}）。没有就算了，不许补写。`]
  }
  const head = raw.trim()
  const brief = head.length > YESTERDAY_HEAD_CHARS ? head.slice(0, YESTERDAY_HEAD_CHARS) + '\n…' : head
  return [`昨天记在 ${PROFILE.booksDir}/${key}.txt，开头是：`, '---', brief, '---']
}

/** 上个月的月记键，如 2026-09 */
function prevMonthKey(now) {
  const d = new Date(now.getTime())
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return localDateKey(d).slice(0, 7)
}

/**
 * 月初那一趟：上个月的月记还没写，就提醒一次。
 *
 * 月记 = 自我叙事，不是数据压缩。真人写月记是在总结"这个月算怎么回事"。
 */
function monthlyBlock(now) {
  if (now.getDate() > 3) return []
  const key = prevMonthKey(now)
  const file = `${PROFILE.booksDir}/${key}.md`
  if (readText(diaryPath(key).replace(/\.txt$/, '.md')) !== null) return []
  return [
    `该写上个月的月记了：${file}`,
    '  不是在压缩数据，是总结「那个月算怎么回事」。写三段就够：',
    '  · 主题（一句话）',
    '  · 关键词（三五个）',
    '  · 一句总结',
    '',
  ]
}

/**
 * 工作区变化。只给事实，不写「我扫描了工作区发现…」那种机器味。
 * 他在不在忙、值不值得说，让她自己判断。
 */
function changesBlock(changes, dice) {  if (!changes || !changes.length) return []
  // 概率行为：energy 低的时候懒得看（"今天不想动电脑"）—— 只掐观察，掐不掉任务
  if (dice?.skipObservation) return []
  // 视而不见：一次只「注意到」2~3 件
  const limit = dice?.noticeCount ?? changes.length
  return [
    '工作区里最近动过这些：',
    ...changes.slice(0, limit).map((c) => `· ${c.rel}`),
    '  只是路过瞥见的，别当成任务，也别照单汇报。',
    '',
  ]
}

/**
 * L2 能力段。
 *
 * ⚠️ 这是**提示词级**的，不是代码强制的 —— 明写在技术债里（见 const.js 的 L2_ALLOWED）。
 * 措辞刻意写成「你自己该有的分寸」，不写成「系统禁止你」：
 * 它约束她的自觉，不约束她的能力；能力那道闸在 agent preset 的权限里。
 */
function toolsBlock() {
  // 本子名跟着 profile 走（L2_ALLOWED 里只留占位符）
  const fill = (x) =>
    x
      .replaceAll('{books}', PROFILE.booksDir)
      .replaceAll('{expectations}', PROFILE.expectations)
      .replaceAll('{tasks}', PROFILE.tasks)
      .replaceAll('{dossierJson}', PROFILE.dossierJson)
  return [
    '你能自己动手，不用问：',
    ...L2_ALLOWED.map((x) => `· ${fill(x)}`),
    `写操作一天以 ${DAILY_WRITE_BUDGET} 次为限 —— 不是硬闸，是你自己该有的分寸。`,
    '',
  ]
}

/**
 * 召回段：前几天记起的一段。
 *
 * 跟闪回要分清：这是**她记得的**、带日期、是事实；闪回是随机、标「不知道为什么」。
 * 所以这里不写「不知道为什么」，写「前几天记的」。
 */
function recallBlock(recalled) {
  if (!recalled) return []
  // 2026-10-27 改：召回不再是「原样引用旧日记」，而是**带一句当下的评价**。
  //   人重读自己的日记会觉得「我当时怎么这么想」，不会照念。
  //   原来的写法把旧句子直接摆进来，等于读日志，不像回忆。
  //   这里只给指示不给内容 —— 评价必须是她自己现想的，代码不替她评价。
  return [
    `前几天记的（${recalled.key.slice(5)}）：`,
    `「${recalled.text}」`,
    '（这是那天写下的字。现在再看，大概已经不一样了 —— 顺着现在的想法说，不用照念。）',
    '',
  ]
}

/**
 * 白天账：**已退役**（2026-10-26 融合成一条时间线之后）。
 *
 * 它存在的理由是「她和主会话之间没有共同的当下」。
 * 融合之后话就落在同一个会话里，不存在两个书房了 —— 这一块自然失效。
 * 磁盘上的 `灵溪-白天账.md` 留作历史记录，不再注入提示。
 */
function dayLogBlock() {
  return []
}

/**
 * 梦。只在夜里那趟提，而且**明确可以不写**。
 *
 * 三条硬规矩（其余两条在 index.js 与 skill.js 里落实）：
 *   · 梦不进事实层 —— 写进 灵溪日记/梦/，插件从不把它读回事实上下文
 *   · 不用讲逻辑 —— 但它自己有判断力，别写成流水账
 *   · 可以不写 —— 真人不是每晚都记得
 */
function dreamBlock(now) {
  const key = localDateKey(now)
  return [
    '【夜里】这一天差不多收工了。',
    '可以做一件不做也无妨的事：把今天碎的几样随便拼一拼，写成梦。',
    `  写到 ${PROFILE.booksDir}/梦/${key}.md。`,
    '  不用讲逻辑，不用有结论，荒唐一点也没关系。',
    '  不写也行。',
    '',
  ]
}

/**
 * 拼完整唤醒提示。
 *
 * @param {object} p
 * @param {Date}   p.now
 * @param {object} p.plan        今天的计划（含 skip / speaks）
 * @param {number|null} p.daysSinceHeard
 * @param {number|null} p.prevDaysSinceHeard
 * @param {object|null} [p.branches]     behaviorBranches(freshness) 的结果
 * @param {object|null} [p.expectation]  pickForWake() 选中的那一条
 * @param {object|null} [p.tasks]        loadTasks() 的结果
 * @param {Array}       [p.changes]       recentChanges() 的结果
 * @param {object|null} [p.dice]          behaviorDice(energy) 的结果
 * @returns {string}
 */
export function buildWakeText({
  now,
  plan,
  daysSinceHeard,
  prevDaysSinceHeard,
  expectation = null,
  tasks = null,
  changes = null,
  flashback = null,
  dayLog = null,
  recalled = null,
  offerDream = false,
  echo = null,
}) {
  // 人格：宿主已经注入的，这里不再说第二遍（2026-10-27 晚定）。
  //   只在「宿主没有角色层、但有 persona/core.md」时由插件顶上 —— 别人接入走这条。
  //   省下的是每趟约 1800 字；换来的是同一个人格只出现一次。
  const owner = personaOwner()
  const persona = owner === 'plugin' ? readPersona(PERSONA_MAX_CHARS) : ''
  const dayKey = localDateKey(now)
  // 2026-10-30 第七刀：`nth` 不再是「一天第几趟」，是「今天第几次醒」。
  //   它只剩两个用处：措辞变体轮换（pickOpener/pickCloser）、以及「有没有上一趟」。
  //   **不参与任何额度判断** —— 次数已经没有了，别拿它算「还剩几次」。
  const nth = Number(plan?.count ?? 0) + 1
  const late = now.getHours() >= LATE_NIGHT_HOUR

  const head = []
  if (persona) head.push(persona, '')
  else if (owner === 'none') {
    // 两样都没有：这不是该悄悄发生的事，明说出来，免得她只剩机制还装作有人格
    head.push('（这一趟没读到人格文件 —— 按你自己的判断说话，别硬演。）', '')
  }

  // 2026-10-30 第七刀：删掉「懒日」分支。
  //   懒日原来是「今天只醒一次、只写日记」—— 那是排班里的一次特例。
  //   第七刀之后醒不醒本来就看概率，一天不醒也是可能的，所以「懒日」这个概念没了。

  const mood = [] // 2026-10-29 拆除：原来按沉默天数写「少说两句 / 不必主动开口」
  const speakAllowed = true // 沉默不再收紧开口；开不开口由她定（架构 §9）
  // 现读：她自改过的措辞要立刻生效，不能等重启（2026-10-28）
  const voice = currentVoice()
  // 看板优先：她重写过的那份是"现在"，比日记原文碎片更贴近她要的第一眼。
  //   没有看板（老工作区）就退回昨天日记 —— 行为不变。
  const board = boardBlock()
  const before = board.length ? board : yesterdayBlock(now)
  const opener = pickOpener(voice, nth)
  const closer = pickCloser(voice, nth)

  const lines = [...head, clockLine(now), '']
  if (opener) lines.push(opener, '')
  // 回响：上一趟之后他动没动过（给事实，判断归她）
  lines.push(...echoBlock(echo))
  // 她走过的路：最近几条经历（只读，不许她改）
  // 反刍：二手吃多了还没消化，先消化

  // ── 深夜：更轻更短，只留下一件事 ─────────────────────────────────
  if (late) {
    lines.push(
      ...before,
      '',
      '时间不早了，这一趟不做别的：',
      ...diaryNowBlock(now),
      '写完就睡。有话才写，不许只写「今天没事」。',
      ...privateBlock(now),
      '',
    )
    if (offerDream) lines.push(...dreamBlock(now))
    lines.push(
      '想说一句就说一句，一句就够。',
      closer,
    )
    return lines.join('\n')
  }

  lines.push(...callbackBlock(now, nth))
  lines.push(...before, '')

  // 余额：事实，不是任务。低了她自己看要不要提

  // 2026-10-29 删：沉默段（mood）与行为分支（branches）—— 都是代码替她判断状态

  // 他这几天在看什么：紧跟「他的今天」之后 —— 先说关系，再说材料

  // 他挑的那个系列：背景之后才是正题材料

  // 闪回：真的没有因果的那一样（随机抽的旧句子）
  if (flashback) {
    lines.push('（不知道为什么，脑子里忽然冒出一句：）', `「${flashback.text}」`, '')
  }

  // 召回：她记得的（带日期，是事实）—— 这一层以前没有，等于只读昨天
  lines.push(...recallBlock(recalled))

  lines.push(...changesBlock(changes))

  // 2026-10-29 第二刀：`if (belief)` 那段删了 —— beliefs.js 已拆，belief 恒为 null。


  // 误解闭环：猜错过的，点名

  // 工具失败账本

  lines.push(...monthlyBlock(now))

  // 任务账本：交代的事必须给交代
  if (tasks) {
    const tl = taskLines(tasks)
    if (tl.length) lines.push(...tl, '')
  }

  // 9 号：L2 能力（提示词级）。脚手架可撤 —— 她熟练了就不必再教
  const showTools = true
  if (showTools) lines.push(...toolsBlock())

  // 期待层：她还在想的事（素材，不是任务）
  if (expectation) {
    lines.push(
      '你还在想的事：',
      `· ${describe(expectation)}`,
      '',
      '想提就提，不想提就放着 —— 这条只是个念头，不是今天必须做的事。',
      '',
    )
  }

  // 脚手架：写熟了就不必再讲格式；「可做可不做」那条也是
  const showFormat = true
  const showHints = true

  lines.push(
    // 2026-10-30 第七刀：删掉「第几趟 / 共几趟」—— 次数已经不存在了。
    //   还写「第 N 趟」就是在提醒她「你还有额度」，那正是要消掉的东西。
    '',
    // 2026-10-29 第三刀：原来写的是「这一趟只有一件事是**必须**的」。
    //   「必须」是祈使任务 —— 架构 §7.4 明令禁止（醒来只给事实与资源，不给任务清单），
    //   而 §3.2 写的是**她**决定要不要写日记。命令和自主不能同时成立。
    //   改成陈述现状：日记在哪、现在多长、可以接。
    '今天的日记在这儿：',
    ...diaryNowBlock(now),
    '  想接着写就接着写；不写也不算这一趟白醒。',
    // 2026-10-30 第七刀：原来只有「游荡趟」有这句。现在每次醒都是随机醒，
    //   所以每次都给 —— 醒不是任务。
    '  这一趟没有作业：想逛就逛，想待着就待着，什么都不做也算醒过。',
    ...privateBlock(now),
  )

  if (showFormat) {
    // 2026-10-27：日记改成 v2.3 的四栏（DS 讨论采纳 / 与 skill.js 的判卷对齐）
    // 2026-10-28：写法改口 —— **第一人称 + 用她对你的称呼**，不要中性记录。
    //   借 dsh-companion-memory 的判据：通篇写「他」就成了病历本，不是她记的事；
    //   「能不能当面说出口」是判断汇报腔的唯一标准。
    lines.push(
      // 详略：她自己提过 diary.detail=brief 就按 brief 走（自改生效的落点之一）。
      //   注意这只改「写多少」，不改「写什么」—— 四栏本身不许省。
      readJson(PATHS.params)?.diaryDetail === 'brief'
        ? '  今天没什么精神，四栏各写一句也行 —— 但「今天没事」不算写了。'
        : '  按这四栏写：',
      `  写法：**用「我」和「${PROFILE.callHim}」写**，不要写「他」「用户」「对方」。`,
      '    留着你当时说话的语气和原话，别压缩成记录。写完一句，默问：这话我能当面说出口吗？',
      `  —— 今天做了什么 ——（${PROFILE.callHim}做了什么、我做了什么、走到哪一步。这是主体。）`,
      '  —— 为什么 ——（今天为什么做、或为什么不做。理由不过滤，「想休息」也算理由。）',
      '  —— 想到什么 ——（自由写，想到哪写到哪。）',
      '  —— 不同意 ——（今天有没有哪件事你没照做、或者心里不认同？',
      '    一行一条，写成「- [判断] 什么 —— 为什么」或「- [身体] 什么 —— 为什么」。',
      '    理由可以空，但空着的那条将来不算数。没有就写「没有」。）',
      // ⚠️ 栏名**一个字都不能改**：skill.js 判卷、callbackBlock 全按字面量认。
      //   要改说话方式就在正文里改（用「我」「阿锦」），别动标题。
      `  —— 想对他说什么 ——（可以留空。空本身是信号；写的时候用「${PROFILE.callHim}」。）`,
      '  「今天没事」不算写了。',
    )
  } else {
    // 格式已经不用教了，只留底线一句
    lines.push('  照老样子写，四栏那条别漏。别只写「今天没事」。')
  }

  if (showHints) {
    lines.push(
      '',
      '其余的都可做可不做：',
      '  · 读昨天那份，看看上次说到哪',
      '  · 看他最近在忙什么，没什么可说就别说',
      '  · 想记着的事写进 ' + PROFILE.expectations + '（最多 3 条，字段照文件里现有的格式）',
      '  · 关于他：写档案条目时带 source —— 跟他处出来的不用写（默认算 interaction），',
      '    看来的写 "web"。看来的那些**不会进事实层**，只能当引子。',
    )
  }

  // 每天第一趟提一次：他说烦了就记账。档位是代码算的，她只管记。
  // 只提一次 —— 每趟都说会变成唠叨，而她本来就不缺这一条规定。
  if (nth === 1) {
    lines.push(
      '（他说过烦、让你少叫的时候：把那天和他的原话记进 .lingxi/feedback.json 的 complaints，',
      '  形如 {"day":"YYYY-MM-DD","said":"他的原话"}。同一天记一条就够 —— 别自己算次数，代码会降档。）',
      '',
      // 自改提案（2026-10-28）：她能提，不能自己生效。每天第一趟提一次，别念叨。
      '（想改自己：可以提，但**不会当场生效** —— 要跨两天都提、再满 7 天。）',
      '  能改的只有三样：voice.closers / voice.openers（各最多 5 条）、diary.detail（full 或 brief）。',
      '  写进 .lingxi/proposals.json 的 items 里，一条三样：{"target":"voice.closers","op":"add",',
      '  "value":"先这样。","reason":"为什么","days":["YYYY-MM-DD"]}。同一个念头换天再提，就多记一天。',
      '  身份、性情、行为准则、边界、原日记 —— 这些提了也会被拒，别浪费一趟。',
      '',
    )
  }

  // 看板：过了 BOARD_HOUR、今天还没提过，就提一次（2026-10-30 第七刀改）。
  //   原来靠「今天最后一趟」—— 第七刀之后没有「最后一趟」了（醒来是概率的），
  //   所以改成看钟点，并且记一天一次。
  //   **重写，不是追加** —— 日记是证据，看板是视图；遗忘发生在看板上。
  if (now.getHours() >= BOARD_HOUR && plan?.boardDay !== dayKey) {
    lines.push(
      '',
      `这一趟是今天最后一趟。把看板重写一遍：${PROFILE.nowBoard}`,
      '  它回答的是「现在」，不是「今天发生了什么」—— 流水在日记里，看板只留还用得上的。',
      `  · 每条 ≤${BOARD_ITEM_CHARS} 字，一句一件；要细节就写「详情在 xxx.md」，别把细节塞进来`,
      `  · 通篇用「${PROFILE.callHim}」和「我」，不写「他」「用户」`,
      '  · 事情办完了、话题过去了就删掉 —— 看板可以忘，日记不许改',
    )
  }

  lines.push(
    '',
    // 2026-10-27 改：开口从「义务」改成「判断」。
    //   原来按额度说话 —— 还有几次就得开口几次，那是义务，不是想说话。
    //   现在把准绳交给她：有没有值得说的。没话就只写日记，这一趟照样算走完了。
    // 2026-10-29：去掉沉默档的「今天不必主动开口」分支 —— 沉默不再收紧开口（架构 §9）。
    [
      '开口不开口，这一趟由你定：',
      `  有值得说的就说一句；没有就别开口，只把日记写了，这一趟也算过去了。`,
      // 2026-10-30 第七刀：删掉「今天还剩 N 趟」—— 没有额度了，也就没有「还剩」。
      // 2026-10-27 晚定（信箱）：她说话的地方是他的侧栏以外，他根本不会去看。
      // 所以「想让他知道的」必须落进日记那一栏 —— 否则等于对着空房间说。
      '  ⚠️ 你在这里说的话，他看不见。想让他知道的，写进日记的「想对他说什么」那一栏；',
      '     他下回开口时会看到。写在那里的话才有人接，其余的只是自言自语。',
      '说完就收，别追问。',
    ].join('\n'),
    `收工。${closer}`,
  )

  return lines.join('\n')
}

/** 他自己回来后的提示（不叫醒，只在本会话里递一句），暂时没接 */
export function buildResumeText() {
  return ''
}

export { daysSince, prevMonthKey }

// 2026-10-30 第七刀：`buildRoamText` 删了。
//   「游荡趟」这个概念没了 —— 醒就是醒，不再分「有作业的醒」和「没作业的醒」。
//   原来那句「这一趟没有作业」搬进了 buildWakeText，每一次醒都带着它。
