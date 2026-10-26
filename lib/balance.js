/**
 * 余额：两条路，先读账本，账本旧了自己查。
 *
 * ① **账本**（首选）：小鲸鱼每轮观测一次，写 `~/.dsh/.dshw-usage.json`。
 *    它那套是「差值记账」—— 每次拿新余额跟上次比，少了记消耗、多了记充值，
 *    还过滤乱序样本、金额走整数（×1e8）避浮点漂移。重写一遍不划算。
 *
 * ② **自己查**（账本旧了才走）：调 `https://api.deepseek.com/user/balance`。
 *    凭据**不碰 `.credentials.yaml`** —— 那是结构化记录（kind/payload/secret），
 *    拆它等于绕过宿主管凭据的设计。问宿主要：
 *
 *        const cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
 *
 *    这行是从小鲸鱼那里照抄来的（它 index.js:1425）。它还有个 `accountFallback()`
 *    走 DSH 账号登录态，我们没做 —— 一条路都还没验通，先不加第二条。
 *
 * ③ **都没有 → 什么都不说**。以前会留一句「这数未必准」，那只是噪音：
 *    要么给准的，要么闭嘴。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson } from './home.js'
import {
  BALANCE_LOW,
  BALANCE_CRITICAL,
  BALANCE_URL,
  BALANCE_TIMEOUT_MS,
  BALANCE_RETRY_MS,
} from './const.js'

/** 小鲸鱼的账本 */
function usageFile() {
  return path.join(PATHS.dshHome, '.dshw-usage.json')
}

/** 从账本读数（同 10-26 那版，不动） */
export function readBalance(now = Date.now()) {
  const raw = readJson(usageFile())
  if (!raw || typeof raw !== 'object') return { balance: null, today: null, day: null, ageMs: null }

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

/** 太旧的余额不能当事实说（他可能刚充过钱） */
export function isStale(b, maxAgeMs = 12 * 3600_000) {
  return b.ageMs !== null && b.ageMs > maxAgeMs
}

/** 从 `balance_infos` 里挑一条：优先人民币，没有就第一条 */
export function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || !infos.length) return null
  const cny = infos.find((x) => x && String(x.currency || '').toUpperCase() === 'CNY')
  return cny || infos[0] || null
}

/**
 * 问接口要余额。
 *
 * @returns {{ ok:boolean, balance?:number, code?:string, error?:string }}
 */
export async function fetchLiveBalance(ctx, now = Date.now()) {
  let cred = null
  try {
    cred = await ctx?.credentials?.resolve?.('DEEPSEEK_API_KEY')
  } catch (e) {
    return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + String(e?.message ?? e).slice(0, 120) }
  }
  if (!cred) return { ok: false, code: 'NO_KEY', error: '没有 DEEPSEEK_API_KEY，也没拿到登录态' }

  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      })
    } catch (e) {
      lastErr = e
      if (attempt === 0) await new Promise((r) => setTimeout(r, BALANCE_RETRY_MS))
      continue
    }
    if (!res.ok) {
      lastErr = new Error('HTTP ' + res.status)
      if (res.status < 500) break // 4xx 重试没意义
      if (attempt === 0) await new Promise((r) => setTimeout(r, BALANCE_RETRY_MS))
      continue
    }
    let data
    try {
      data = await res.json()
    } catch {
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
    }
    const info = pickBalanceInfo(data && data.balance_infos)
    const n = info ? Number(info.total_balance) : NaN
    if (!Number.isFinite(n)) return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
    return { ok: true, balance: n }
  }
  return { ok: false, code: 'NET', error: String(lastErr?.message ?? lastErr).slice(0, 120) }
}

/**
 * 定余额：账本新鲜就用账本，旧了或没有就问接口，都不行就给空。
 *
 * @returns {{ balance:number|null, today:number|null, day:string|null, source:'ledger'|'api'|'none', error?:string }}
 */
export async function resolveBalance({ ctx = null, now = Date.now(), maxAgeMs } = {}) {
  const led = readBalance(now)
  if (led.balance !== null && !isStale(led, maxAgeMs)) {
    return { balance: led.balance, today: led.today, day: led.day, source: 'ledger' }
  }

  const live = await fetchLiveBalance(ctx, now)
  if (live.ok) {
    // 接口只给余额，不给「今天用了多少」—— 那就只说余额，不编一个数出来
    return { balance: live.balance, today: null, day: led.day, source: 'api' }
  }

  // 账本有数但旧了，接口又不行 → 宁可不提
  return { balance: null, today: null, day: led.day, source: 'none', error: live.error }
}

/**
 * 拼提示里那几行。只给事实；低额与否由代码判档，怎么说由她定。
 */
export function balanceLines(b, { stale = false } = {}) {
  if (!b || b.balance === null) return []
  const yuan = (n) => n.toFixed(2)

  const out = [`（余额 ${yuan(b.balance)} 元`]
  if (b.today !== null) out[0] += `，今天已用 ${yuan(b.today)}`
  out[0] += b.source === 'api' ? '；刚查的' : ''
  out[0] += stale ? '；这数有点旧了，未必准）' : '）'

  if (!stale) {
    if (b.balance <= BALANCE_CRITICAL) {
      out.push(`  ⚠️ 快见底了（低于 ${BALANCE_CRITICAL} 元）—— 该跟他说一声。`)
    } else if (b.balance <= BALANCE_LOW) {
      out.push(`  不多了（低于 ${BALANCE_LOW} 元）。要不要提，你自己看。`)
    }
  }

  out.push('')
  return out
}
