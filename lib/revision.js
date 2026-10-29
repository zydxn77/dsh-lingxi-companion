/**
 * 自改白名单（2026-10-28，B 阶段第一步）。
 *
 * 目标：她能从自己的经历里生出「我想改」的念头，但那念头**不能自己生效**。
 * 插件只做三件事：收提案、算资格、落盘（带旧值可回退）。
 *
 * 两个决定（他 10-28 早上定的）：
 *   ① 提案落在 `.lingxi/proposals.json`（结构化）—— 写进日记或 growth.md 等于让代码猜语义；
 *   ② 资格 = **跨两天出现 + 满 7 天**（两条都要）。她的改变本来就该稀有：
 *      单靠跨两天，一次情绪连两天就改了；单靠七天，一次冲动放七天也能过。
 *
 * ⚠️ 白名单只有真正需要代码闸的东西。另外几项（自主选择输入 / 期待条目 / 重新解释旧事）
 *   **本来就发生在文件里** —— 它们的闸是「她有没有写文件的权限」（agent preset 管），
 *   不是这个模块。把那些也塞进来只会造一个假闸门。
 *
 * 永不开放（连提案都不收）：性情 · 身份 · 约束 · 原始日记。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 最短冷却：从提出到生效至少几天。 */
export const PROPOSAL_COOLDOWN_DAYS = 7

/** 至少在几个不同的日子里出现过。 */
export const PROPOSAL_MIN_DAYS = 2

/** 账本最多留多少条（只追加，满了丢最老的已结案）。 */
export const PROPOSAL_KEEP = 60

const DAY = 86_400_000

/**
 * 白名单。key 是「改什么」，值说明允许的操作与校验。
 *
 * 只收三种：
 *   voice.openers / voice.closers —— 措辞（单条增删，不许整套换）
 *   diary.detail                  —— 日记详略（full / brief）
 */
export const WHITELIST = {
  'voice.closers': { ops: ['add', 'remove'], maxChars: 40, label: '收尾那句' },
  'voice.openers': { ops: ['add', 'remove'], maxChars: 40, label: '开场那句' },
  'diary.detail': { ops: ['set'], enum: ['full', 'brief'], label: '日记详略' },
}

/** 明令不收的（给报错用，也给人看）。 */
export const NEVER = ['身份', '性情', '行为准则', '边界', '原始日记', '档位']

/** 提案账本位置。 */
export function proposalsPath(stateDir) {
  return path.join(stateDir, 'proposals.json')
}

function readJsonQuiet(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 读账本。坏文件当空账 —— 一次手滑不该让插件起不来。 */
export function loadProposals(file) {
  const raw = readJsonQuiet(file)
  const items = Array.isArray(raw?.items) ? raw.items : []
  return {
    // ⚠️ 不因为缺 days 就把整条丢掉：她手写 JSON，漏字段是常事。
    //   丢掉等于**静默消失**（她以为提了，代码当没看见）；留着它，waitFor 会说清还差什么。
    items: items
      .filter((x) => x && typeof x.id === 'string' && typeof x.target === 'string')
      .map((x) => ({
        ...x,
        days: Array.isArray(x.days) ? x.days.filter((d) => typeof d === 'string') : [],
        status: typeof x.status === 'string' ? x.status : 'pending',
      })),
  }
}

export function saveProposals(file, store) {
  const items = (store?.items ?? []).slice(-PROPOSAL_KEEP)
  return writeJsonAtomic(file, { items })
}

/** 校验一条提案能不能进白名单。返回 null = 可以，否则是拒绝原因。 */
export function rejectReason({ target, op, value }) {
  const rule = WHITELIST[target]
  if (!rule) {
    return `「${target}」不在白名单里。能自己改的只有：${Object.keys(WHITELIST).join(' / ')}；` +
      `${NEVER.join('、')} 永远不行`
  }
  if (!rule.ops.includes(op)) return `「${target}」只允许 ${rule.ops.join(' / ')}，不收 ${op}`
  const text = String(value ?? '').trim()
  if (!text) return 'value 不能是空的'
  if (rule.maxChars && text.length > rule.maxChars) {
    return `太长了（${text.length} 字，上限 ${rule.maxChars}）—— 换一句短的，别写一段`
  }
  if (rule.enum && !rule.enum.includes(text)) return `只能填 ${rule.enum.join(' / ')}`
  return null
}

/**
 * 提一条。同一条（目标+操作+值）**不同天再提一次只累加天数**，不新建。
 *
 * @param {object} store loadProposals 的结果
 * @param {object} input {target, op, value, reason, source}
 * @param {Date} now
 * @returns {{store:object, id:string|null, why:string|null, merged:boolean}}
 */
export function propose(store, input, now = new Date()) {
  const why = rejectReason(input)
  const day = localDay(now)
  if (why) return { store, id: null, why, merged: false }

  const items = Array.isArray(store?.items) ? store.items.slice() : []
  const value = String(input.value).trim()
  const same = items.find(
    (x) =>
      x.target === input.target &&
      x.op === input.op &&
      String(x.value) === value &&
      (x.status === 'pending' || x.status === 'applied'),
  )

  if (same) {
    if (!same.days.includes(day)) same.days.push(day)
    if (!same.reason && input.reason) same.reason = String(input.reason).slice(0, 200)
    return { store: { items }, id: same.id, why: null, merged: true }
  }

  const id = `${day}-${items.length + 1}`
  items.push({
    id,
    target: input.target,
    op: input.op,
    value,
    reason: String(input.reason ?? '').slice(0, 200),
    source: input.source === 'web' ? 'web' : 'interaction',
    days: [day],
    status: 'pending',
    createdAt: now.toISOString(),
    appliedAt: null,
    old: null,
  })
  return { store: { items }, id, why: null, merged: false }
}

/**
 * 这条够格生效了吗（纯判定，不动文件）。
 *
 * 两条都要：跨 ≥2 个不同日子出现，且距首次提出已满 7 天。
 */
export function isReady(item, now = new Date()) {
  if (!item || item.status !== 'pending') return false
  const days = Array.isArray(item.days) ? [...new Set(item.days)] : []
  if (days.length < PROPOSAL_MIN_DAYS) return false
  const born = Date.parse(item.createdAt)
  if (!Number.isFinite(born)) return false
  return now.getTime() - born >= PROPOSAL_COOLDOWN_DAYS * DAY
}

/** 还差什么才能生效 —— 给她看的实话，不给假安慰。 */
export function waitFor(item, now = new Date()) {
  const days = Array.isArray(item?.days) ? [...new Set(item.days)] : []
  const born = Date.parse(item?.createdAt)
  const lackedDays = Math.max(0, PROPOSAL_MIN_DAYS - days.length)
  const left = Number.isFinite(born)
    ? Math.max(0, PROPOSAL_COOLDOWN_DAYS * DAY - (now.getTime() - born))
    : PROPOSAL_COOLDOWN_DAYS * DAY
  const parts = []
  if (lackedDays > 0) parts.push(`还要在另外 ${lackedDays} 天里再出现`)
  if (left > 0) parts.push(`还要等 ${Math.ceil(left / DAY)} 天`)
  return parts.join('，') || '已经够格了'
}

/** 本地日期键（不依赖 home.js，免得循环引用）。 */
function localDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 落地一条。只碰白名单里的文件：voice.json / params.json。
 *
 * 返回 {ok, old} 或 {ok:false, why}，**调用方负责把结果写回账本**。
 */
export function applyOne(item, ctx) {
  const rule = WHITELIST[item.target]
  if (!rule) return { ok: false, why: '不在白名单' }

  if (item.target === 'voice.openers' || item.target === 'voice.closers') {
    const file = ctx.voicePath
    const raw = readJsonQuiet(file) ?? {}
    const key = item.target === 'voice.closers' ? 'closers' : 'openers'
    const list = Array.isArray(raw[key]) ? raw[key].slice() : []

    if (item.op === 'add') {
      if (item.target === 'voice.closers') {
        if (list.includes(item.value)) return { ok: false, why: '已经有了' }
        if (list.length >= 5) return { ok: false, why: '收尾最多 5 条，先删一条再加' }
      } else {
        const texts = list.map((x) => (typeof x === 'string' ? x : x?.text))
        if (texts.includes(item.value)) return { ok: false, why: '已经有了' }
        if (list.length >= 5) return { ok: false, why: '开场最多 5 条，先删一条再加' }
        list.push({ text: item.value, when: 'later' })
      }
      if (item.target === 'voice.closers') list.push(item.value)
      const next = { ...raw, [key]: list }
      if (!writeJsonAtomic(file, next)) return { ok: false, why: '写不进 voice.json' }
      return { ok: true, old: { key, list: raw[key] ?? [] } }
    }

    // remove：按字面值删（openers 认 text 字段）
    const before = list.length
    const kept = list.filter((x) => (typeof x === 'string' ? x : x?.text) !== item.value)
    if (kept.length === before) return { ok: false, why: '找不到这一句' }
    if (!kept.length) return { ok: false, why: '不能删空 —— 至少留一条' }
    const next = { ...raw, [key]: kept }
    if (!writeJsonAtomic(file, next)) return { ok: false, why: '写不进 voice.json' }
    return { ok: true, old: { key, list: raw[key] ?? [] } }
  }

  if (item.target === 'diary.detail') {
    const file = ctx.paramsPath
    const raw = readJsonQuiet(file) ?? {}
    const before = raw.diaryDetail ?? 'full'
    const next = { ...raw, diaryDetail: item.value }
    if (!writeJsonAtomic(file, next)) return { ok: false, why: '写不进 params.json' }
    return { ok: true, old: { key: 'diaryDetail', value: before } }
  }

  return { ok: false, why: '白名单里没有这个落点' }
}

/**
 * 回退一条：把 `old` 写回去。
 *
 * 这是我给的后悔药 —— 她改了，觉得不对，可以退。
 */
export function rollbackOne(item, ctx) {
  if (item.status !== 'applied' || !item.old) return { ok: false, why: '没生效过，没什么可退' }
  const { key, list, value } = item.old
  if (item.target === 'diary.detail') {
    const raw = readJsonQuiet(ctx.paramsPath) ?? {}
    if (!writeJsonAtomic(ctx.paramsPath, { ...raw, diaryDetail: value })) {
      return { ok: false, why: '写不进 params.json' }
    }
    return { ok: true }
  }
  const raw = readJsonQuiet(ctx.voicePath) ?? {}
  if (!writeJsonAtomic(ctx.voicePath, { ...raw, [key]: list })) {
    return { ok: false, why: '写不进 voice.json' }
  }
  return { ok: true }
}

/**
 * 一次推进：把所有够格的 pending 落地，返回处理结果。
 *
 * 不改账本状态 —— 状态由调用方写（那里才知道日志怎么写）。
 *
 * @returns {Array<{id:string, ok:boolean, why?:string, old?:any}>}
 */
export function applyReady(store, ctx, now = new Date()) {
  const out = []
  for (const item of store?.items ?? []) {
    if (!isReady(item, now)) continue
    const r = applyOne(item, ctx)
    out.push({ id: item.id, ok: r.ok, why: r.why, old: r.old })
  }
  return out
}
