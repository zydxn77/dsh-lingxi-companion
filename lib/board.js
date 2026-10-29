/**
 * 状态看板（2026-10-28，借 dsh-companion-memory 的 STATUS.md）。
 *
 * 两套东西分工，别混：
 *
 *   日记（`灵溪日记/YYYY-MM-DD.txt`）—— **证据**。原话，只追加，旧的不许改。
 *   看板（`灵溪-现在.md`）           —— **视图**。她每天重写一次，可以删、可以忘。
 *
 * 「遗忘发生在看板上，不发生在证据里」—— 这就是它说的「类似遗忘，而不是断片」。
 *
 * 三条规矩（都是那条方案的判据，而且**可机械检查**）：
 *   1. 每条描述 ≤ 50 字（`BOARD_ITEM_CHARS`）；
 *   2. 需要细节的，写一行「详情在 xxx.md」，不把细节塞进看板；
 *   3. 通篇用她对他的称呼，不写「他」「用户」—— 那是第三人称，写出来像病历本。
 *
 * ⚠️ 插件**只读**看板，不替她写。她是作者，代码只负责把它递回提示、并检查有没有超长。
 */
import { PATHS, PROFILE, readText } from './home.js'

/** 一条描述的字数上限。超了不是错，是提醒 —— 看板一膨胀就不叫看板了。 */
export const BOARD_ITEM_CHARS = 50

/** 看板整体上限（字）。超了说明该往记忆库挪了。 */
export const BOARD_MAX_CHARS = 1400

/** 「详情在 xxx」这类索引行不算超长。 */
const INDEX_LINE = /详情在|见 `|见 .*\.md/

/** 拆行 + 去掉空行与标题/引用/分隔线。 */
export function boardLines(text) {
  if (!text) return []
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[#>|]/.test(l) && !/^[-=*]{3,}$/.test(l))
}

/**
 * 检查看板结构。返回问题清单（空数组 = 合格）。
 *
 * 只查三样能查的：超长条目、整体膨胀、通篇「他」。
 * 语气好不好、有没有脑补 —— 代码判不了，别假装能。
 */
export function boardIssues(text, { callHim = PROFILE.callHim } = {}) {
  const issues = []
  const body = String(text ?? '')
  if (!body.trim()) return issues

  if (body.replace(/\s+/g, '').length > BOARD_MAX_CHARS) {
    issues.push(`整体超过 ${BOARD_MAX_CHARS} 字：该往记忆库里挪了`)
  }

  for (const line of boardLines(body)) {
    const plain = line.replace(/^[-·*]\s*/, '')
    if (INDEX_LINE.test(plain)) continue
    // 去掉 markdown 粗体标记再数，别让 ** 算进字数
    const bare = plain.replace(/\*\*/g, '').trim()
    if (bare.length > BOARD_ITEM_CHARS) {
      issues.push(`超长（${bare.length} 字，上限 ${BOARD_ITEM_CHARS}）：${bare.slice(0, 30)}…`)
    }
  }

  // 通篇没有一次称呼、却反复出现「他」—— 第三人称视角
  const heCount = (body.match(/他/g) ?? []).length
  const callCount = callHim ? (body.match(new RegExp(callHim, 'g')) ?? []).length : 0
  if (heCount >= 3 && callCount === 0) {
    issues.push(`通篇写「他」（${heCount} 次）、一次「${callHim}」都没有 —— 像病历本，不像她记的`)
  }

  return issues
}

/** 看板存不存在（存在就当"现在"用，不存在退回昨天日记）。 */
export function loadBoard() {
  const raw = readText(PATHS.nowBoard)
  return raw && raw.trim() ? String(raw) : ''
}

/**
 * 拼进唤醒提示的那一段。
 *
 * 给了看板就用看板，**不再塞昨天日记的原文开头** —— 那段是碎布，看板是消化过的。
 * 没有看板就返回空，调用方会退回原来的写法（兼容老工作区）。
 */
export function boardBlock() {
  const board = loadBoard()
  if (!board) return []
  const issues = boardIssues(board)
  const lines = [
    // 2026-10-29 第三刀：把来源标清。这是**她自己写的摘要**，不是日记原文 ——
    //   架构 §7.4 的白名单只收日记原文，看板要留就得让性质一目了然。
    //   ⚠️ 目录名走 PROFILE，别写死（自检：lib 里除 profile.js 不许出现具体名字）。
    `（这是你自己写的摘要，不是日记原文 —— 原文在 ${PROFILE.booksDir}/ 里。）`,
    '---',
  ]
  lines.push(...board.trim().split('\n').map((l) => l))
  lines.push('---')
  if (issues.length) {
    // 把问题明说出来：代码查不到的（语气、脑补）另说，查得到的必须修
    lines.push('⚠️ 这份看板有几处要改（下趟重写时顺手改）：')
    for (const x of issues.slice(0, 4)) lines.push(`  · ${x}`)
  }
  lines.push('')
  return lines
}
