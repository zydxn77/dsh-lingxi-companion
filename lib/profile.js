/**
 * 她是谁 —— 人格接口层（2026-10-27，A 阶段）。
 *
 * 为什么要这一层：这个包原来整套是「灵溪」写死的 —— 28 处，散在 9 个文件里，
 * 连日记目录名、信箱名、档案名都是她的名字。别人下载下来接上自己的人格，
 * 结果她还是叫灵溪、日记还写进 `灵溪日记/`。那不是接口，那是她的私人物品。
 *
 * 所以「她是谁」从代码里搬出来，只剩两份可替换的东西：
 *
 *   workspace/.lingxi/profile.json   名字、本子名、信箱名、人设标记
 *   workspace/.lingxi/voice.json     开场 / 收尾（措辞变体）
 *   workspace/persona/core.md        人的内核 —— 读到就放提示词第一行
 *
 * **不在这两份里的，才是机制**：作息、抽签、衰减、档位、记忆层。
 * 机制不认识"灵溪"这两个字，它只认识 profile 里的字段。
 *
 * B 阶段（成长）预留了两个槽，现在不实现：
 *   · `voice` 的取用签名已带 `nth`，将来还要带 mood —— 现在多留参数，将来不用改调用点；
 *   · `persona/growth.md` 只追加不修改，A 阶段写入者是人，B 阶段才轮到她。
 *
 * ⚠️ 这个文件是**唯一允许出现具体名字**的 lib 文件。自检里有一条盯着它：
 *    除了这里，`lib/*.js` 的非注释行里不许再出现「灵溪」。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 默认档案 —— 本机就是灵溪，所以默认值写她。
 * 别人接入：改 `workspace/.lingxi/profile.json`，不用碰这个文件。
 */
export const DEFAULT_PROFILE = {
  /** 她的名字，只用于日志和默认人设名 */
  name: '灵溪',
  /**
   * 她怎么叫他（2026-10-28）。
   *
   * 用来要求她的日记/看板**通篇用这个称呼**，不写「他」「用户」——
   * 「他」是第三人称，写出来就成了病历本，不是她记的事。
   * 换人只改这里。
   */
  callHim: '阿锦',
  /** 日记目录（一天一个 txt，月记一个 md，梦在子目录） */
  booksDir: '灵溪日记',
  /** 留言信箱 */
  inbox: '灵溪-留言.json',
  /** 他的档案：老 markdown 只当 identity；现行走 JSON */
  dossierMd: '灵溪-关于他.md',
  dossierJson: '灵溪-关于他.json',
  /** 期待层 / 任务账本 / 白天账 */
  expectations: '灵溪-期待.json',
  tasks: '灵溪-任务.json',
  daylog: '灵溪-白天账.md',
  /**
   * 游荡记录（2026-10-28 加）。她写，只追加 —— 一行一条：逛到哪、为什么停。
   *
   * 这是「她能自己逛」留下的脚印。Coo 的游荡是屏幕上走给你看，
   * 我们的游荡只能是这份账 —— 表演层是客户端插件的活，不在这一层。
   */
  roamLog: '灵溪-游荡.md',
  /**
   * 外发箱（2026-10-29 晚加）：她想**现在**跟他说的话。
   *
   * 她自己写，插件只搬运 —— 不判断哪句值得说。
   * 为什么不是 `.lingxi/` 里：她必须能读能写，而 `.lingxi/` 是宿主的账本，她不该碰。
   */
  sayBox: '灵溪-想说.json',
  /**
   * 状态看板（2026-10-28 加）。
   *
   * 借 dsh-companion-memory 的 STATUS.md：**她是重写它，不是追加它**。
   * 日记是证据（原话，只追加），看板是视图（可以重写）——
   * 遗忘发生在看板上，不发生在证据里。
   */
  nowBoard: '灵溪-现在.md',
  /** AGENTS.md 里人设那一段的标记；有 persona/core.md 时用不上 */
  personaMarker: '# 角色层',
}

/**
 * 默认措辞。这些原来是 `prompt.js` 里写死的 `OPENERS` / `CLOSERS` ——
 * 它们是**人格**，不该住在机制里。
 *
 * `{n}` = 第几趟。`when: 'later'` = 第一趟不出现（今天还没"再"过一次）。
 */
export const DEFAULT_VOICE = {
  openers: [
    { text: '这一趟是今天第 {n} 次。', when: 'later' },
    { text: '又醒了一回，今天第 {n} 次。', when: 'later' },
    { text: '第 {n} 次了。', when: 'later' },
  ],
  closers: ['别加戏。', '做完就好。', '不用勉强。'],
}

/** 读一个 JSON，坏了就当没有 —— 一个人格文件写错不该让插件装不上。 */
function readJsonQuiet(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 浅合并：只让补丁覆盖它自己说了的字段。 */
export function mergeProfile(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ...base }
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && !value.trim()) continue
    out[key] = value
  }
  return out
}

/** 这个工作区里的她是谁。没有配置文件就是默认（灵溪）。 */
export function resolveProfile(workspace) {
  return mergeProfile(DEFAULT_PROFILE, readJsonQuiet(path.join(workspace, '.lingxi', 'profile.json')))
}

/** 措辞变体。可只覆盖 closers，openers 保持默认。 */
export function resolveVoice(workspace) {
  const patch = readJsonQuiet(path.join(workspace, '.lingxi', 'voice.json'))
  const voice = {
    openers: DEFAULT_VOICE.openers.map((o) => ({ ...o })),
    closers: [...DEFAULT_VOICE.closers],
  }
  const openers = Array.isArray(patch?.openers) ? patch.openers : []
  const cleaned = openers
    .filter((o) => o && typeof o.text === 'string' && o.text.trim())
    .map((o) => ({ text: String(o.text), when: o.when === 'always' ? 'always' : 'later' }))
  if (cleaned.length) voice.openers = cleaned

  const closers = Array.isArray(patch?.closers) ? patch.closers : []
  const goodClosers = closers.filter((c) => typeof c === 'string' && c.trim())
  if (goodClosers.length) voice.closers = goodClosers

  return voice
}

/**
 * 取开场白。按第几趟取模 —— 确定性，不是随机。
 *
 * 签名留了两个参数（voice, nth）：B 阶段要按心情挑变体时，多接一个 mood 即可，
 * 不会牵动任何调用点。现在只用 nth。
 */
export function pickOpener(voice, nth) {
  const list = voice?.openers?.length ? voice.openers : DEFAULT_VOICE.openers
  const picked = list[nth % list.length]
  if (!picked) return ''
  if (picked.when === 'later' && nth <= 1) return ''
  return String(picked.text).replaceAll('{n}', String(nth))
}

/** 取收尾。同理按第几趟取模。 */
export function pickCloser(voice, nth) {
  const list = voice?.closers?.length ? voice.closers : DEFAULT_VOICE.closers
  return list[nth % list.length] ?? ''
}
