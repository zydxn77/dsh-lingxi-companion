/**
 * L1 观察：她醒来时「路过瞥见」的工作区变化。
 *
 * 只是素材，不是指令 —— 提示里会给，她爱看不看。
 * 也**不是**工具调用：插件在叫醒前自己扫一遍，零权限、零成本。
 *
 * 措辞红线（文档 ⑤）：不许写成「我扫描了工作区发现…」的机器味。
 * 所以这里只返回事实（哪些文件最近动过），拼句子的活交给 prompt.js。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PROFILE } from './home.js'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.lingxi',
  '.scratch',
  // 她自己那几个本子不算「工作区变化」—— 2026-10-27 起跟着 profile 走
  PROFILE.booksDir,
  PROFILE.name,
  '__pycache__',
  '.venv',
  'dist',
  'build',
])

const MAX_ENTRIES = 4000

/**
 * 最近 hours 小时内动过的文件，按时间倒序。
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.hours=24]
 * @param {number} [opts.limit=6]   最多返回几条
 * @param {number} [opts.depth=2]   递归深度（1 = 只看根目录）
 * @param {string[]} [opts.skipNames] 额外跳过的文件名（日记、账本之类）
 * @returns {{ rel: string, mtime: number }[]}
 */
export function recentChanges(root, opts = {}) {
  const hours = Number(opts.hours ?? 24)
  const limit = Number(opts.limit ?? 6)
  const maxDepth = Number(opts.depth ?? 2)
  const skipNames = new Set(opts.skipNames ?? [])
  const since = Date.now() - hours * 3600_000

  const hits = []
  let scanned = 0
  const stack = [{ dir: root, depth: 0 }]

  while (stack.length && scanned < MAX_ENTRIES) {
    const { dir, depth } = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      scanned += 1
      if (scanned >= MAX_ENTRIES) break
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth >= maxDepth) continue
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        stack.push({ dir: p, depth: depth + 1 })
        continue
      }
      if (skipNames.has(e.name)) continue
      try {
        const mt = fs.statSync(p).mtimeMs
        if (mt >= since) hits.push({ rel: path.relative(root, p).replace(/\\/g, '/'), mtime: mt })
      } catch {
        /* 文件刚被删 */
      }
    }
  }

  return hits.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/**
 * 最近动过的**顶层目录**。给「误解」用。
 *
 * ⚠️ 2026-10-26 收窄过一次。原来只看「目录最近动过」就猜，结果当天就猜错了：
 *    它把 `lingxi-companion`（那天我们自己一行行搭起来的）猜成「你开了个新东西」。
 *
 *    加一个判据：**有 manifest 的目录不算「随手开的新东西」** ——
 *    package.json / README.md / .git 在那儿，说明那是个正经工程，不是一时兴起的空壳。
 *    顺手建的目录通常是空的、或者只有两个文件。
 *
 * @returns {{name:string, mtime:number, manifest:boolean}[]}
 */
export function recentDirs(root, opts = {}) {
  const hours = Number(opts.hours ?? 72)
  const skip = new Set(opts.skip ?? [])
  const since = Date.now() - hours * 3600_000
  const MANIFEST = ['package.json', 'README.md', '.git', 'pyproject.toml', 'Cargo.toml']

  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || skip.has(e.name)) continue
    const abs = path.join(root, e.name)
    let mt = 0
    try {
      mt = fs.statSync(abs).mtimeMs
    } catch {
      continue // 刚被删
    }
    if (mt < since) continue

    let manifest = false
    try {
      manifest = MANIFEST.some((m) => fs.existsSync(path.join(abs, m)))
    } catch {
      /* 读不了就当没有 */
    }
    out.push({ name: e.name, mtime: mt, manifest })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
