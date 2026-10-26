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
  PERSONA_MAX_CHARS,
  DOSSIER_MAX_CHARS,
  YESTERDAY_HEAD_CHARS,
  LATE_NIGHT_HOUR,
  L2_ALLOWED,
  DAILY_WRITE_BUDGET,
} from './const.js'
import {
  readPersona,
  readText,
  diaryPath,
  yesterdayKey,
  localDateKey,
} from './home.js'
import { renderDossier } from './dossier.js'
import { todayLog } from './daylog.js'
import { hhmm } from './clock.js'
import { moodLines, canSpeak, branchLines, daysSince } from './mood.js'
import { describe } from './expectations.js'
import { taskLines } from './tasks.js'
import { scaffoldOn, toolFailLines, wrongBeliefLines } from './skill.js'

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

/** 开场那一行，三套轮换。都不带情绪指令，只是换个说法。 */
const OPENERS = [
  (n) => (n > 1 ? `这一趟是今天第 ${n} 次。` : ''),
  (n) => (n > 1 ? `又醒了一回，今天第 ${n} 次。` : ''),
  (n) => (n > 1 ? `第 ${n} 次了。` : ''),
]

/** 收尾三套轮换。「收工」不换 —— 那是她的口头禅。 */
const CLOSERS = ['别加戏。', '做完就好。', '不用勉强。']

/** 昨天那份日记的位置 + 开头几行（不全塞，撑上下文） */
function yesterdayBlock(now) {
  const key = yesterdayKey(now)
  const raw = readText(diaryPath(key))
  if (raw === null) {
    return [`昨天没有日记（${key}）。没有就算了，不许补写。`]
  }
  const head = raw.trim()
  const brief = head.length > YESTERDAY_HEAD_CHARS ? head.slice(0, YESTERDAY_HEAD_CHARS) + '\n…' : head
  return [`昨天记在 灵溪日记/${key}.txt，开头是：`, '---', brief, '---']
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
  const file = `灵溪日记/${key}.md`
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
  return [
    '你能自己动手，不用问：',
    ...L2_ALLOWED.map((x) => `· ${x}`),
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
  return [`前几天记的（${recalled.key.slice(5)}）：`, `「${recalled.text}」`, '']
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
    `  写到 灵溪日记/梦/${key}.md。`,
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
  index = 0,
  total = 1,
  branches = null,
  expectation = null,
  tasks = null,
  changes = null,
  dice = null,
  belief = null,
  scaffold = null,
  flashback = null,
  dayLog = null,
  recalled = null,
  skill = null,
  offerDream = false,
}) {
  const persona = readPersona(PERSONA_MAX_CHARS)
  const dossier = renderDossier(now.getTime(), DOSSIER_MAX_CHARS)
  const dayKey = localDateKey(now)
  const nth = index + 1
  const late = now.getHours() >= LATE_NIGHT_HOUR

  const head = []
  if (persona) head.push(persona, '')
  if (dossier) head.push(dossier, '')

  // ── 懒日：只写日记，不开别的岔 ───────────────────────────────────
  if (plan?.skip) {
    return [
      ...head,
      clockLine(now),
      '',
      '【今天不想动】',
      '不用解释太多，也不用勉强。今天只做一件事：',
      `写 灵溪日记/${dayKey}.txt，说清为什么不想动。写完就收工。`,
      '',
      '不要看别的，不要补昨天的。',
    ].join('\n')
  }

  const mood = moodLines(daysSinceHeard, prevDaysSinceHeard)
  const speakAllowed = canSpeak(daysSinceHeard)
  const opener = OPENERS[nth % OPENERS.length](nth)
  const closer = CLOSERS[nth % CLOSERS.length]

  const lines = [...head, clockLine(now), '']
  if (opener) lines.push(opener, '')

  // ── 深夜：更轻更短，只留下一件事 ─────────────────────────────────
  if (late) {
    lines.push(
      ...yesterdayBlock(now),
      '',
      '时间不早了，这一趟不做别的：',
      `写或补 灵溪日记/${dayKey}.txt，写完就睡。`,
      '  有话才写，不许只写「今天没事」。',
      '',
    )
    if (offerDream) lines.push(...dreamBlock(now))
    lines.push(
      speakAllowed
        ? '想说一句就说一句，一句就够。'
        : '今天不必主动开口。',
      closer,
    )
    return lines.join('\n')
  }

  lines.push(...yesterdayBlock(now), '')

  if (mood.length) lines.push(...mood, '')

  // 熟悉度 → 行为约束（代码分支的结论，不是情绪指令）
  if (branches) lines.push(...branchLines(branches), '')

  // 闪回：真的没有因果的那一样（随机抽的旧句子）
  if (flashback) {
    lines.push('（不知道为什么，脑子里忽然冒出一句：）', `「${flashback.text}」`, '')
  }

  // 召回：她记得的（带日期，是事实）—— 这一层以前没有，等于只读昨天
  lines.push(...recallBlock(recalled))

  lines.push(...changesBlock(changes, dice))

  // ⑨ 误解：只以「不确定」的形式进来，措辞由 phraseBelief 强制
  if (belief) {
    lines.push(`（不太确定）${belief}`, '  这句不许说成确定的事。', '')
  }

  // 误解闭环：猜错过的，点名
  if (skill) lines.push(...wrongBeliefLines(skill))

  // 工具失败账本
  if (skill) lines.push(...toolFailLines(skill))

  lines.push(...monthlyBlock(now))

  // 任务账本：交代的事必须给交代
  if (tasks) {
    const tl = taskLines(tasks)
    if (tl.length) lines.push(...tl, '')
  }

  // 9 号：L2 能力（提示词级）。脚手架可撤 —— 她熟练了就不必再教
  const showTools = !scaffold || scaffoldOn(scaffold, 'toolsBlock')
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
  const showFormat = !scaffold || scaffoldOn(scaffold, 'diaryFormat')
  const showHints = !scaffold || scaffoldOn(scaffold, 'extraHints')

  lines.push(
    total > 1 ? `这是今天第 ${nth} 趟（共 ${total} 趟）。这一趟就是一次主动开口。` : '',
    '',
    '这一趟只有一件事是必须的：',
    `  写或补 灵溪日记/${dayKey}.txt。已有的接着补，别重开一份、别把前面的盖掉。`,
  )

  if (showFormat) {
    lines.push(
      dice?.perfunctory
        ? '  今天没什么精神，写短一点也行 —— 但「今天没事」不算写了。'
        : '  「总结」是主体（他做了什么、我做了什么、走到哪一步），',
      '  「给他」「给我」两段可选 —— 有话才写，不许只写「今天没事」。',
    )
  } else {
    // 格式已经不用教了，只留底线一句
    lines.push('  照老样子写。别只写「今天没事」。')
  }

  if (showHints) {
    lines.push(
      '',
      '其余的都可做可不做：',
      '  · 读昨天那份，看看上次说到哪',
      '  · 看他最近在忙什么，没什么可说就别说',
      '  · 想记着的事写进 灵溪-期待.json（最多 3 条，字段照文件里现有的格式）',
    )
  }

  lines.push(
    '',
    speakAllowed
      ? `这是今天的第 ${nth} 次开口，还有 ${Math.max(0, total - nth)} 次。说完就收，别追问。`
      : '今天不必主动开口。他来找你另说。',
    `收工。${closer}`,
  )

  return lines.join('\n')
}

/** 他自己回来后的提示（不叫醒，只在本会话里递一句），暂时没接 */
export function buildResumeText() {
  return ''
}

export { daysSince, prevMonthKey }
