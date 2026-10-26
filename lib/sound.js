/**
 * 专属提示音：她开口的时候响一下，让你知道「是她，不是随便一轮」。
 *
 * ⚠️ 为什么需要「专属」：小鲸鱼本来就在响 —— `turnCostOn` 每一轮结束响一次
 *     「每轮消耗」。她投一句也算一轮，所以那个音已经会响。
 *     再放一个普通音只是叠噪音。这里放的必须是**只有她开口才响**的那个。
 *
 * 为什么由 host 播、而不是加个 client 半：
 *   我们的插件是纯 host（没有 `dsh.client`）。为了放一个 wav 去加半个前端、
 *   走 slot 注册、还要重建 web 产物 —— 不成比例。
 *   host 里 spawn 一个播放器，一天最多三次，代价可以忽略。
 *
 * 平台：Windows 用 PowerShell 的 `System.Media.SoundPlayer`（只吃 wav）。
 * 播不出来不算失败 —— 声音是锦上添花，绝不能因为它拖垮投递。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { SOUND_FILE, SOUND_ENABLED } from './const.js'

/**
 * 放一声。异步、不等待、不抛错。
 *
 * @param {(m:string)=>void} [log]
 * @returns {boolean} 有没有真的发起播放
 */
export function playPing(log = () => {}) {
  if (!SOUND_ENABLED) return false
  if (process.platform !== 'win32') return false

  if (!fs.existsSync(SOUND_FILE)) {
    log(`提示音文件不存在：${SOUND_FILE}`)
    return false
  }

  try {
    const ps = `(New-Object System.Media.SoundPlayer '${SOUND_FILE.replace(/'/g, "''")}').PlaySync()`
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { stdio: 'ignore', windowsHide: true, detached: true },
    )
    child.on('error', (e) => log('提示音没放出来：' + e.message))
    child.unref()
    return true
  } catch (e) {
    log('提示音没放出来：' + (e?.message ?? e))
    return false
  }
}
