/**
 * 余额：读小鲸鱼已经攒好的观测，不自己调 API。
 *
 * 为什么不去调 `api.deepseek.com/user/balance`：
 *   ① 要拆凭据 —— `~/.dsh/.credentials.yaml` 是结构化记录（kind/payload/secret），
 *      拆它等于绕过宿主自己管凭据的设计
 *   ② 小鲸鱼每轮都在观测，数据现成：`~/.dsh/.dshw-usage.json`
 *
 * 我们只做一件事：**把它读出来，变成她能看见的事实**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson } from './home.js'
import { BALANCE_LOW, BALANCE_CRITICAL } from './const.js'

/** 小鲸鱼的数据文件 */
function usageFile() {
  return path.join(PATHS.dshHome, '.dshw-usage.json')
}

/**
 * 读余额观测。
 *
 * @returns {{ balance:number|null, today:number|null, day:string|null, ageMs:number|null }}
 */
export function readBalance(now = Date.now()) {
  const raw = readJson(usageFile())
  if (!raw || typeof raw !== 'object') {
    return { balance: null, today: null, day: null, ageMs: null }
  }

  let ageMs = null
  try {
    ageMs = now - fs.statSync(usageFile()).mtimeMs
  } catch {
    /* 读不到时间就不知道新旧 */
  }

  return {
    balance: Number.isFinite(raw.lastBalance) ? raw.lastBalance : null,
    today: Number.isFinite(raw.todayUsage) ? raw.todayUsage : null,
    day: typeof raw.date === 'string' ? raw.date : null,
    ageMs,
  }
}

/** 这数还有多新 —— 太旧的余额不能当事实说（他可能刚充过钱） */
export function isStale(b, maxAgeMs = 12 * 3600_000) {
  return b.ageMs !== null && b.ageMs > maxAgeMs
}

/**
 * 拼提示里那几行。
 *
 * 只给事实。低额与否由代码判档，怎么说由她定 —— 不写成「请提醒主人充值」那种指令。
 */
export function balanceLines(b, { stale = false } = {}) {
  if (b.balance === null) return []
  const yuan = (n) => n.toFixed(2)

  const out = [`（余额 ${yuan(b.balance)} 元`]
  if (b.today !== null) out[0] += `，今天已用 ${yuan(b.today)}`
  out[0] += stale ? '；这数有点旧了，未必准）' : '）'

  if (!stale) {
    if (b.balance <= BALANCE_CRITICAL) {
      out.push(`  ⚠️ 快见底了（低于 ${BALANCE_CRITICAL} 元）—— 该跟他说一声。`)
    } else if (b.balance <= BALANCE_LOW) {
      out.push(`  不多了（低于 ${BALANCE_LOW} 元）。要不要提，你自己看。`)
    }
  } else {
    out.push('  别把这数当准的报给他。')
  }

  out.push('')
  return out
}
