/**
 * 分歧条目 —— ⑩ 人格生成「分化层」的数据入口（2026-10-27 加）。
 *
 * 为什么要有它：MD 里写「分化层 = 日记里的『不同意』条目，与模仿层分开存」，
 * 可原来那几栏（今天做了什么 / 为什么 / 想到什么 / 想对他说什么）**没有一栏承载"我不同意"** ——
 * 「为什么」是解释自己行为的理由，不是反对他的场合。
 * 于是 ⑩ 层是悬空的：固化层要「统计反复出现的不同意」，可不同意从来没被结构化地记下来过。
 *
 * 这一版**只做数据入口**，不做固化。攒一个月再看值不值得往下做。
 *
 * 约定的行格式（提示词里会教她这么写）：
 *
 *   - [判断] 不同意现在去做 bundle —— 账本还没跑稳，形态焊死了要返工
 *   - [身体] 今天不想动电脑 —— 昨晚只睡了三小时
 *
 * 两种理由分开记，是 DS 讨论定的（身体性 vs 判断性）。
 * 理由可以空，但会被标出来（missingReason）——
 * 分化层只认**带理由**的条目，没理由的分歧只是情绪，不该固化成人格。
 */
import { extractSection } from './text.js'

/** 认得的理由类型。别的写法一律落到「未分类」，不丢条目。 */
export const REASON_KINDS = ['身体', '判断']

/** 「今天没有」的各种写法，都算空。 */
const EMPTY = /^(没有|无|今天没有|没|没有呢)[。.！!]?$/

/**
 * 从一份日记里切出分歧条目。
 *
 * @param {string} text 整份日记
 * @returns {Array<{kind:string, what:string, reason:string, missingReason:boolean}>}
 *   没有这一栏、或者写的是「没有」，都返回空数组（空数组≠异常）。
 */
export function extractDisagreements(text) {
  const section = extractSection(text, '不同意')
  if (section === null) return []
  const body = String(section).trim()
  if (!body || EMPTY.test(body)) return []

  const out = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    // 只认列表行 —— 段落式的散文不当条目，避免把解释性文字误收成分歧
    if (!/^[-·*]/.test(line)) continue
    let s = line.replace(/^[-·*]\s*/, '').trim()
    if (!s) continue

    let kind = '未分类'
    const tag = /^\[([^\]]{1,8})\]\s*/.exec(s)
    if (tag) {
      const t = tag[1].trim()
      kind = REASON_KINDS.includes(t) ? t : '未分类'
      s = s.slice(tag[0].length)
    }

    // 「内容 —— 理由」；没有破折号就是没给理由
    const parts = s.split(/\s*(?:——|—{2,}|–)\s*/)
    const what = String(parts[0] ?? '').trim()
    const reason = String(parts.slice(1).join('——') ?? '').trim()
    if (!what) continue

    out.push({ kind, what, reason, missingReason: !reason })
  }
  return out
}
