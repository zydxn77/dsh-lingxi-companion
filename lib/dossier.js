/**
 * 「关于他」档案 —— 三级衰减。
 *
 * ⚠️ 全永不衰减是错的：几年后这份东西会变成「事实仓库」，不是记忆。
 *    真人的记忆是有层次的：你讨厌什么记得一辈子，他上周改了哪个文件你三天就忘了。
 *
 * | 级 | 内容 | 衰减 |
 * |---|---|---|
 * | identity    | 讨厌什么、喜欢什么、重要经历 | 永不 |
 * | preference  | 最近在忙什么、最近爱听什么   | 慢（30 天） |
 * | observation | 某天改过哪个文件之类的细节   | 快（3 天） |
 *
 * 存 `灵溪-关于他.json`。她写内容，衰减跑代码。
 * 老的 `灵溪-关于他.md` 仍然认（只当 identity 级，永不衰减）——
 * 那是上一版的东西，不删，读得到就用。
 */
import { PATHS, readJson, readText } from './home.js'

export const TIERS = ['identity', 'preference', 'observation']

/** 每一级活多少天。Infinity = 永不。 */
export const TIER_TTL_DAYS = {
  identity: Infinity,
  preference: 30,
  observation: 3,
}

const DAY = 86_400_000

const clampDays = (iso, now) => {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (now - t) / DAY)
}

/** 这条还活着吗 */
export function isAlive(item, now = Date.now()) {
  const ttl = TIER_TTL_DAYS[item.tier] ?? 3
  if (!Number.isFinite(ttl)) return true
  return clampDays(item.updated, now) <= ttl
}

/**
 * 读档案。返回**已经过滤掉过期项**的列表。
 *
 * @returns {{ items: {text:string, tier:string, updated:string}[], expired: number, legacy: boolean }}
 */
export function loadDossier(now = Date.now()) {
  const raw = readJson(PATHS.dossierJson)
  let items = []
  let legacy = false

  if (raw && Array.isArray(raw.items)) {
    items = raw.items
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({
        text: String(x.text).trim(),
        tier: TIERS.includes(x.tier) ? x.tier : 'observation',
        updated: typeof x.updated === 'string' ? x.updated : new Date().toISOString(),
      }))
  } else {
    // 兼容上一版的自由格式 markdown：整份当 identity，永不衰减
    const md = readText(PATHS.dossier)
    if (md && md.trim()) {
      legacy = true
      items = [{ text: md.trim(), tier: 'identity', updated: new Date(0).toISOString() }]
    }
  }

  const alive = items.filter((x) => isAlive(x, now))
  return { items: alive, expired: items.length - alive.length, legacy }
}

/**
 * 渲染成提示里的那一段。按 级 → 时间新 排序，超长就截。
 */
export function renderDossier(now = Date.now(), maxChars = 1200) {
  const { items, expired, legacy } = loadDossier(now)
  if (!items.length) return ''

  const order = { identity: 0, preference: 1, observation: 2 }
  const sorted = [...items].sort((a, b) => {
    const d = (order[a.tier] ?? 3) - (order[b.tier] ?? 3)
    if (d !== 0) return d
    return Date.parse(b.updated) - Date.parse(a.updated)
  })

  const label = { identity: '', preference: '', observation: '（细节）' }
  const lines = sorted.map((x) => `· ${label[x.tier] ?? ''}${x.text}`)
  let out = lines.join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…'
  if (legacy) out = out.replace(/\n/g, '\n')
  if (expired > 0) out += `\n（另有 ${expired} 条已经淡忘）`
  return out
}
