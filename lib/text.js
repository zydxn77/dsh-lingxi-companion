/**
 * 纯文本工具。
 *
 * 2026-10-29 第二刀：`extractSection` 从 `skill.js` 搬过来（实现一字未改）。
 * skill.js 整份拆了（判日记 / 脚手架衰减 / 猜目录，见架构 §12.3），
 * 但"按栏名切文本"只是字符串处理，跟给她打分没关系，所以留下。
 */

export function extractSection(text, name) {
  if (!text) return null
  const src = String(text)
  // 标题必须在**行首** —— 正文里随手写的「—— 什么 ——」不该被当成章节
  const marker = new RegExp(`^[ \\t]*——[ \\t]*${name}[ \\t]*——`, 'm')
  const m = marker.exec(src)
  if (!m) return null
  const rest = src.slice(m.index + m[0].length)
  // 切到下一个「—— X ——」为止。
  // 2026-10-27 修：原来这里是 /\s*[^—\n]{1,8}\s*——/ —— `\s*` 能吃换行 ✗
  //   于是正文任何一行「内容 —— 理由」都会被当成下一节的标题，把后面整段截掉。
  //   「不同意」那一栏的行格式（`- [判断] 某事 —— 理由`）正好踩中，一写就丢。
  //   现在：必须行首、必须同一行内闭合。
  const next = /^[ \t]*——[ \t]*[^—\n]{1,8}[ \t]*——/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}
