/**
 * 闪回：从旧日记里随手抽一句，当成「不知道为什么想起来」的素材。
 *
 * 为什么它算「无意识」：这是全篇唯一一处**真的没有因果**的东西 ——
 * 抽哪一句只由随机数决定，跟今天说了什么、做了什么毫无关系。
 *
 * 三条限制：
 *   · 只抽两天以前的（近期的事昨天那份已经带着了）
 *   · 一天最多一次（看 skill.flashbackDay）
 *   · 只是素材 —— 提示里会标「不知道为什么」，不许当成刚刚发生的事
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, localDateKey } from './home.js'
import { FLASHBACK_MIN_AGE_DAYS } from './const.js'

/** 从一份日记里挑一句「像话」的。导出给召回层复用。 */
export function pickSentence(text, rng = Math.random) {
  const lines = String(text)
    .split(/[\n。！？]/)
    .map((s) => s.trim())
    // 过滤掉标题、分隔线、小标题、清单项
    .filter((s) => s.length >= 8 && s.length <= 60)
    .filter((s) => !/^[—～~\-=\d]/.test(s))
    .filter((s) => !/^(总结|给他|给我|说明)$/.test(s))
  if (!lines.length) return null
  return lines[Math.floor(rng() * lines.length)]
}

/**
 * @returns {{ text: string, key: string } | null}
 */
export function pickFlashback(now = new Date(), rng = Math.random) {
  let names = []
  try {
    names = fs
      .readdirSync(PATHS.diaryDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(n))
  } catch {
    return null
  }
  if (!names.length) return null

  const today = localDateKey(now)
  const cutoff = new Date(now.getTime() - FLASHBACK_MIN_AGE_DAYS * 86_400_000)
  const cutoffKey = localDateKey(cutoff)

  const old = names.filter((n) => n.slice(0, 10) <= cutoffKey && n.slice(0, 10) !== today)
  if (!old.length) return null

  // 最多试 4 份，懒得抽的换一份
  for (let i = 0; i < Math.min(4, old.length); i++) {
    const key = old[Math.floor(rng() * old.length)].slice(0, 10)
    try {
      const raw = fs.readFileSync(path.join(PATHS.diaryDir, `${key}.txt`), 'utf8')
      const s = pickSentence(raw, rng)
      if (s) return { text: s, key }
    } catch {
      /* 读不了换下一份 */
    }
  }
  return null
}
