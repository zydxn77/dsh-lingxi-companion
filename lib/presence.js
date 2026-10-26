/**
 * 在场直方图：他一般什么时候在这台机器上。
 *
 * 数据只有一样 —— `~/.dsh/sessions` 下每个会话文件的**最后修改时刻**。
 * 一个文件投一票，投给它最后活动那一小时。样本稀疏，但真实，且零成本。
 *
 * 用途：加权抽签。她在他常在的时段醒来，说的话才有人接。
 * 为什么不用「均匀随机」：均匀是公平的，但不是拟人的 —— 活人的作息有峰谷。
 *
 * ⚠️ 已知偏差：
 *   · 一个会话只投一票，聊得久的一天和只开一条的一天分量一样 —— 不区分强度
 *   · 我（别的 agent）在这台机器上干活，也会给她投一票
 * 这两条都写在注释里，不假装精确。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PRESENCE_SMOOTHING } from './const.js'
import { isOwnSessionPath } from './spine.js'

const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'
const MAX_SCAN = 5000

/**
 * @param {string} sessionsDir
 * @param {string} excludePrefix  她自己的会话 id 前缀，排掉（她醒着不算他在）
 * @returns {{ hours: number[], samples: number }}
 */
export function presenceHistogram(sessionsDir, excludePrefix) {
  const hours = new Array(24).fill(PRESENCE_SMOOTHING)
  let samples = 0
  const stack = [sessionsDir]
  let guard = 0

  while (stack.length && guard < MAX_SCAN) {
    guard += 1
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      if (e.name !== SESSION_FILE_NAME) continue
      // 只看会话目录名 —— 拿整条路径 includes('/lingxi') 会把任何
      // 路径里带 lingxi 的会话全排掉（踩过，见 spine.js 的 isOwnSessionPath）
      if (isOwnSessionPath(p, excludePrefix)) continue
      try {
        const mt = fs.statSync(p).mtimeMs
        const h = new Date(mt).getHours()
        if (h >= 0 && h < 24) {
          hours[h] += 1
          samples += 1
        }
      } catch {
        /* 文件刚被清掉 */
      }
    }
  }

  return { hours, samples }
}

/**
 * 给他常在的时段加权 —— 直接在分钟粒度上按小时权重取。
 *
 * 返回 24 个权重，没样本时全是 1（退化成均匀）。
 */
export function hourWeights(sessionsDir, excludePrefix) {
  const { hours, samples } = presenceHistogram(sessionsDir, excludePrefix)
  if (samples === 0) return null // null 表示「没有他的数据」，调用方退回均匀
  return hours
}

/**
 * 窗口漂移：用他的实际在场时段反推作息窗口。
 *
 * 做法：取直方图均值，把「明显高于均值」的小时圈出来取首尾，
 * 两头各留 pad 小时，再夹进硬边界。
 *
 * 为什么要漂移：他要是改成凌晨三点睡、中午起，固定的 09:00–23:30
 * 就会一直在错的时间叫她 —— 她醒着，他不在。
 *
 * @returns {{start:string,end:string}|null} null = 数据不够，别漂
 */
export function deriveWindow(weights, opts = {}) {
  if (!weights || !weights.length) return null
  const pad = Number(opts.pad ?? 1)
  const minSamples = Number(opts.minSamples ?? 8)

  const total = weights.reduce((a, b) => a + b, 0)
  if (total < minSamples) return null // 样本太少，宁可不动

  const mean = total / 24
  const hot = weights.map((w, h) => ({ h, w })).filter((x) => x.w >= mean)
  if (!hot.length) return null

  let lo = Math.max(6, Math.min(...hot.map((x) => x.h)) - pad) // 别早于 6 点
  let hi = Math.min(23, Math.max(...hot.map((x) => x.h)) + pad) // 别晚于 24 点

  // 窗口太窄就没地方抽签了 —— 撑到至少 4 小时
  if (hi - lo < 4) {
    lo = Math.max(6, Math.min(lo, 19))
    hi = Math.min(23, lo + 4)
  }

  const fmt = (h) => String(h).padStart(2, '0') + ':00'
  return { start: fmt(lo), end: fmt(hi) }
}
