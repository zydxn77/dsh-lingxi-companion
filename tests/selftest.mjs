/**
 * 离线自检。不需要 DSH，不碰会话，不发任何东西。
 *
 *   node tests/selftest.mjs
 *
 * 验的是逻辑和措辞，不是「装上去能不能跑」—— 那个只能装上去看。
 */
import assert from 'node:assert/strict'
import { localDateKey, yesterdayKey, diaryPath, PATHS } from '../lib/home.js'
import { todayLog } from '../lib/daylog.js'
import { extractSection } from '../lib/skill.js'
import { decide, inWindow, pickWakeMs, pickWakeTimes, dayStartMs, hhmm, windowBounds } from '../lib/clock.js'
import {
  moodLines,
  bandOf,
  daysSince,
  canSpeak,
  computeFreshness,
  behaviorBranches,
  branchLines,
  advanceMood,
} from '../lib/mood.js'
import { advance, effectiveInterest, pickForWake, describe } from '../lib/expectations.js'
import { TASK_STATES, assignedOpen, selfOpen, taskLines } from '../lib/tasks.js'
import { TIER_TTL_DAYS, isAlive, renderDossier } from '../lib/dossier.js'
import { behaviorDice } from '../lib/mood.js'
import { deriveWindow } from '../lib/presence.js'
import { buildBelief, phraseBelief } from '../lib/beliefs.js'
import { recallWeight, touchRecall, recallOne } from '../lib/recall.js'
import { pickFlashback } from '../lib/flashback.js'
import {
  gradeDiary,
  scaffoldOn,
  toolFailLines,
  wrongBeliefLines,
  resolveBeliefs,
  guessedDirs,
} from '../lib/skill.js'
import { recentChanges } from '../lib/workspace.js'
import { isOwnSessionPath } from '../lib/spine.js'
import { buildWakeText } from '../lib/prompt.js'
import * as C from '../lib/const.js'

let pass = 0
let fail = 0
function t(title, fn) {
  try {
    fn()
    pass += 1
    console.log('  ok   ' + title)
  } catch (e) {
    fail += 1
    console.log('  FAIL ' + title)
    console.log('       ' + (e?.message ?? e))
  }
}

console.log('\n── 日期 ─────────────────────────────────')
t('localDateKey 用本地时间，不是 UTC', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5) // 本地 2026-01-02 03:04
  assert.equal(localDateKey(d), '2026-01-02')
  // 若误用 toISOString，UTC+8 下会变成 2026-01-01
  if (d.getTimezoneOffset() < 0) assert.notEqual(localDateKey(d), d.toISOString().slice(0, 10))
})
t('localDateKey 补零', () => {
  assert.equal(localDateKey(new Date(2026, 8, 9)), '2026-09-09')
})
t('yesterdayKey 跨月', () => {
  assert.equal(yesterdayKey(new Date(2026, 10, 1, 12)), '2026-10-31')
})
t('日记路径带日期不带扩展冗余', () => {
  assert.ok(diaryPath('2026-10-26').endsWith('2026-10-26.txt'))
})

console.log('\n── 生物钟 ───────────────────────────────')
t('窗口字面量合法', () => {
  const b = windowBounds()
  assert.ok(b.end > b.start)
})
t('唤醒时刻落在窗口内', () => {
  const base = dayStartMs(new Date(2026, 9, 26))
  const b = windowBounds()
  for (const r of [0, 0.25, 0.5, 0.999999]) {
    const ms = pickWakeMs(base, () => r)
    const mins = (ms - base) / 60000
    assert.ok(mins >= b.start && mins < b.end, `r=${r} → ${mins} 分`)
  }
})
t('inWindow 左闭右开', () => {
  const [sh, sm] = C.WAKE_WINDOW.start.split(':').map(Number)
  assert.equal(inWindow(new Date(2026, 9, 26, sh, sm)), true)
  const [eh, em] = C.WAKE_WINDOW.end.split(':').map(Number)
  assert.equal(inWindow(new Date(2026, 9, 26, eh, em)), false)
  assert.equal(inWindow(new Date(2026, 9, 26, sh - 1, 59)), false)
})
t('今天没计划 → 抽一次签', () => {
  const d = decide({ state: {}, now: new Date(2026, 9, 26, 10, 0), rng: () => 0.5 })
  assert.equal(d.action, 'plan')
  assert.equal(d.plan.key, '2026-10-26')
  assert.equal(d.plan.skip, false) // 0.5 > 0.3
})
t('掷到懒日', () => {
  const d = decide({ state: {}, now: new Date(2026, 9, 26, 10, 0), rng: () => 0.1 })
  assert.equal(d.plan.skip, true)
})
t('计划落盘后重启不重抽', () => {
  const now = new Date(2026, 9, 26, 10, 0)
  const first = decide({ state: {}, now, rng: () => 0.5 })
  const again = decide({ state: { plan: first.plan }, now, rng: () => 0.9 })
  assert.notEqual(again.action, 'plan')
  assert.equal(again.plan.atMs, first.plan.atMs)
})
t('一趟一趟地醒：done 递增，到上限就 idle', () => {
  const t0 = new Date(2026, 9, 26, 9, 0).getTime()
  const plan = {
    key: '2026-10-26',
    skip: false,
    times: [t0 + 60 * 60000, t0 + 300 * 60000, t0 + 600 * 60000],
    done: 0,
  }
  const at = (i) => new Date(plan.times[i])
  assert.equal(decide({ state: { plan }, now: new Date(plan.times[0] - 1000) }).action, 'wait')
  assert.equal(decide({ state: { plan }, now: at(0) }).action, 'wake')
  assert.equal(decide({ state: { plan }, now: at(0) }).index, 0)
  const after1 = { ...plan, done: 1 }
  assert.equal(decide({ state: { plan: after1 }, now: at(1) }).index, 1)
  const after3 = { ...plan, done: 3 }
  assert.equal(decide({ state: { plan: after3 }, now: at(2) }).action, 'idle')
})
t('旧格式账本（只有 atMs/wokeAt）→ 今天不补', () => {
  const legacy = { key: '2026-10-26', atMs: 0, skip: false, wokeAt: 123, speaks: 1 }
  assert.equal(decide({ state: { plan: legacy }, now: new Date(2026, 9, 26, 23, 0) }).action, 'idle')
})
t('跨天重新抽签', () => {
  const legacy = { key: '2026-10-25', atMs: 0, skip: false, wokeAt: 123, speaks: 1 }
  assert.equal(decide({ state: { plan: legacy }, now: new Date(2026, 9, 26, 9, 1), rng: () => 0.5 }).action, 'plan')
})
t('每天抽到 3 趟，且升序、互不挨着', () => {
  // 用一串伪随机跑很多次 —— 只测一次是测不出「最坏情况挨在一起」的。
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  for (let round = 0; round < 200; round++) {
    const d = decide({ state: {}, now: new Date(2026, 9, 26, 8, 0), maxOpenings: 3, rng: rnd })
    assert.equal(d.plan.times.length, d.plan.skip ? 1 : 3, '懒日 1 趟，正常 3 趟')
    const sorted = [...d.plan.times].sort((a, b) => a - b)
    assert.deepEqual(d.plan.times, sorted, '时刻必须升序')
    for (let i = 1; i < d.plan.times.length; i++) {
      const gapMin = (d.plan.times[i] - d.plan.times[i - 1]) / 60000
      assert.ok(gapMin >= 55, `第 ${i} 段间隔只有 ${gapMin.toFixed(1)} 分（第 ${round} 轮）`)
    }
  }
})
t('懒日只抽 1 趟', () => {
  const d = decide({ state: {}, now: new Date(2026, 9, 26, 8, 0), rng: () => 0.1 })
  assert.equal(d.plan.skip, true)
  assert.equal(d.plan.times.length, 1)
})
t('沉默档压低趟数', () => {
  const few = decide({ state: {}, now: new Date(2026, 9, 26, 8, 0), maxOpenings: 1, rng: () => 0.5 })
  assert.equal(few.plan.times.length, 1)
  const two = decide({ state: {}, now: new Date(2026, 9, 26, 8, 0), maxOpenings: 2, rng: () => 0.5 })
  assert.equal(two.plan.times.length, 2)
})
t('hhmm 补零', () => {
  assert.equal(hhmm(new Date(2026, 9, 26, 9, 4).getTime()), '09:04')
})

console.log('\n── 心情（措辞是重点）─────────────────────')
t('三档边界', () => {
  assert.equal(bandOf(0), 'normal')
  assert.equal(bandOf(C.SILENT_AFTER_DAYS - 1), 'normal')
  assert.equal(bandOf(C.SILENT_AFTER_DAYS), 'quiet')
  assert.equal(bandOf(C.SILENT_STOP_DAYS - 1), 'quiet')
  assert.equal(bandOf(C.SILENT_STOP_DAYS), 'faint')
  assert.equal(bandOf(null), 'unknown')
})
t('正常时一个字都不说', () => {
  assert.deepEqual(moodLines(1, null), [])
})
t('quiet 档只说事实，不许索取', () => {
  const s = moodLines(4, null).join('\n')
  assert.ok(s.includes('上次说话'))
  for (const bad of ['没有回应你', '在忙吗', '别再问第二次', '需要知道你还在', '主人']) {
    assert.ok(!s.includes(bad), `不该出现「${bad}」`)
  }
})
t('faint 档不追加情绪勒索', () => {
  const s = moodLines(9, null).join('\n')
  assert.ok(s.includes('不是你的过错'))
  assert.ok(!s.includes('回应你'))
})
t('faint 档不许主动开口', () => {
  assert.equal(canSpeak(9), false)
  assert.equal(canSpeak(4), true)
})
t('恢复转折：上次冷、这次暖', () => {
  const s = moodLines(1, 6).join('\n')
  assert.ok(s.includes('他回来了'))
})
t('daysSince 向下取整', () => {
  const now = Date.now()
  assert.equal(daysSince(now - 3 * 86400000, now), 3)
  assert.equal(daysSince(null, now), null)
})

console.log('\n── 唤醒提示 ─────────────────────────────')
const now0 = new Date(2026, 9, 26, 15, 30)
t('人设在第一行（原版那个 bug 的回归测试）', () => {
  const text = buildWakeText({ now: now0, plan: { key: '2026-10-26', skip: false, speaks: 0 }, daysSinceHeard: 1 })
  const firstLine = text.split('\n')[0]
  assert.ok(firstLine.includes('灵溪'), '第一行必须是人设：' + firstLine.slice(0, 40))
  assert.ok(!firstLine.includes('生物钟'), '报时不能抢在人设前面')
})
t('报时只说事实，不说「醒了」', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false, speaks: 0 }, daysSinceHeard: 1 })
  // 融合成一条时间线后上下文是连的，人根本没睡 —— "醒"是个对不上的动作
  assert.ok(text.includes('【到点了】15:30。'))
  assert.ok(!text.includes('醒了'), '不许再说「醒了」')
})
t('有报时、有今天日记路径', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false, speaks: 0 }, daysSinceHeard: 1 })
  assert.ok(text.includes('【到点了】15:30。'))
  assert.ok(text.includes('灵溪日记/2026-10-26.txt'))
})
t('懒日：只写日记，不做三件事', () => {
  const text = buildWakeText({ now: now0, plan: { skip: true }, daysSinceHeard: 1 })
  assert.ok(text.includes('今天不想动'))
  assert.ok(text.includes('灵溪日记/2026-10-26.txt'))
  assert.ok(!text.includes('做三件事'))
})
t('正常日：写着第几趟、共几趟', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 1, total: 3 })
  assert.ok(text.includes('第 2 趟（共 3 趟）'))
  assert.ok(text.includes('还有 1 次'))
})
t('最后一趟说「还有 0 次」', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 2, total: 3 })
  assert.ok(text.includes('还有 0 次'))
})
t('faint 档：提示里也不许开口', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 9, index: 0, total: 1 })
  assert.ok(!text.includes('次开口'))
  assert.ok(text.includes('今天不必主动开口'))
})
t('多趟日：要求补写而不是重开一份', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 1, total: 3 })
  assert.ok(text.includes('别重开一份'))
})
t('不许出现 B 站残留', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false, speaks: 0 }, daysSinceHeard: 1 })
  for (const bad of ['bili', 'B站', 'BV', 'share.via', '主人', 'debrief', 'feed 选题']) {
    assert.ok(!text.includes(bad), `残留：${bad}`)
  }
})
t('人设只取角色层，不带长期记忆', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false, speaks: 0 }, daysSinceHeard: 1 })
  assert.ok(text.includes('# 角色层：灵溪'))
  assert.ok(!text.includes('# 长期记忆'), '人设里混进了长期记忆')
  assert.ok(!text.includes('信用卡'), '人设里混进了账本')
})
t('给她的那本要有细节，不许只写没事', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false, speaks: 0 }, daysSinceHeard: 1 })
  assert.ok(text.includes('不许只写'))
})

console.log('\n── 会话归属（踩过的坑）───────────────────')
t('只看会话目录名，不看整条路径', () => {
  const P = 'C:/Users/x/AppData/Local/Temp/lingxi-smoke-1234/dsh/sessions'
  // 目录名不是 lingxi* → 不是她的（哪怕整条路径含 lingxi）
  assert.equal(isOwnSessionPath(`${P}/session-other/session.v4.jsonl.zstd`, 'lingxi'), false)
  assert.equal(isOwnSessionPath(`${P}/lingxi/session.v4.jsonl.zstd`, 'lingxi'), true)
  assert.equal(isOwnSessionPath(`${P}/lingxi-20261026-2/session.v4.jsonl.zstd`, 'lingxi'), true)
  // 反斜杠路径
  assert.equal(isOwnSessionPath(`${P.replace(/\//g, '\\')}\\lingxi\\session.v4.jsonl.zstd`, 'lingxi'), true)
})

console.log('\n── 熟悉度与行为分支（铁律 7）──────────────')
t('freshness 指数衰减', () => {
  const now = Date.UTC(2026, 9, 26, 12)
  assert.equal(computeFreshness(now, now).toFixed(3), '1.000')
  const d3 = computeFreshness(now - 3 * 86400000, now)
  assert.ok(d3 > 0.35 && d3 < 0.39, `三天应约 0.37，实际 ${d3.toFixed(3)}`)
  const d7 = computeFreshness(now - 7 * 86400000, now)
  assert.ok(d7 < 0.11, `七天应低于 0.11，实际 ${d7.toFixed(3)}`)
})
t('三分支边界', () => {
  assert.equal(behaviorBranches(0.9).band, 'familiar')
  assert.equal(behaviorBranches(0.8).band, 'familiar')
  assert.equal(behaviorBranches(0.79).band, 'normal')
  assert.equal(behaviorBranches(0.2).band, 'normal')
  assert.equal(behaviorBranches(0.19).band, 'distant')
})
t('生疏时禁止直接接旧话题', () => {
  const b = behaviorBranches(0.1)
  assert.equal(b.canRecallPast, false)
  assert.equal(b.mustUseTimeAdverb, true)
  const s = branchLines(b).join('\n')
  assert.ok(s.includes('时间状语'))
  assert.ok(!s.includes('表现得'), '不许写成情绪表演指令')
})
t('熟时不强制时间状语', () => {
  const b = behaviorBranches(0.95)
  assert.equal(b.canRecallPast, true)
  assert.equal(b.mustUseTimeAdverb, false)
})

console.log('\n── 心情三维 ─────────────────────────────')
t('换天才滚 energy，同一天重复跑不会越算越小', () => {
  const m = { affinity: 0.5, baseEnergy: 0.6, energyDay: '2026-10-25', eventsToday: 2, affinityDay: null, lastInteraction: null }
  const a = advanceMood(m, { now: new Date(2026, 9, 26, 10).getTime(), lastHeardMs: null })
  const b = advanceMood(a.mood, { now: new Date(2026, 9, 26, 11).getTime(), lastHeardMs: null })
  assert.equal(a.mood.energyDay, '2026-10-26')
  assert.equal(a.energy, b.energy, '同一天应当稳定')
})
t('他在场 → affinity 升，一天最多升一次', () => {
  const heard = new Date(2026, 9, 26, 9).getTime()
  const m = { affinity: 0.5, baseEnergy: 0.6, energyDay: '2026-10-26', eventsToday: 0, affinityDay: null, lastInteraction: null }
  const a = advanceMood(m, { now: new Date(2026, 9, 26, 10).getTime(), lastHeardMs: heard })
  assert.ok(a.affinity > 0.5, '应当上升')
  const b = advanceMood(a.mood, { now: new Date(2026, 9, 26, 18).getTime(), lastHeardMs: heard })
  assert.equal(b.affinity, a.affinity, '同一天不该涨第二次')
})
t('他不在 → 只朝基线缓慢回落，不暴跌', () => {
  const m = { affinity: 0.9, baseEnergy: 0.6, energyDay: '2026-10-26', eventsToday: 0, affinityDay: '2026-10-20', lastInteraction: null }
  const a = advanceMood(m, { now: new Date(2026, 9, 26, 10).getTime(), lastHeardMs: null })
  assert.ok(a.affinity < 0.9 && a.affinity > 0.85, `应缓慢回落，实际 ${a.affinity}`)
})
t('连着动一分钟不算「又出现一次」', () => {
  const t0 = new Date(2026, 9, 26, 10).getTime()
  const m = { affinity: 0.5, baseEnergy: 0.6, energyDay: '2026-10-26', eventsToday: 0, affinityDay: '2026-10-26', lastInteraction: null }
  const a = advanceMood(m, { now: t0, lastHeardMs: t0 })
  const b = advanceMood(a.mood, { now: t0 + 60_000, lastHeardMs: t0 + 60_000 })
  const c = advanceMood(b.mood, { now: t0 + 120_000, lastHeardMs: t0 + 120_000 })
  assert.equal(c.mood.eventsToday, 1, `每分钟一次不该累加，实际 ${c.mood.eventsToday}`)
})
t('隔半小时以上再出现才 +1', () => {
  const t0 = new Date(2026, 9, 26, 10).getTime()
  const m = { affinity: 0.5, baseEnergy: 0.6, energyDay: '2026-10-26', eventsToday: 0, affinityDay: '2026-10-26', lastInteraction: null }
  const a = advanceMood(m, { now: t0, lastHeardMs: t0 })
  const later = t0 + 45 * 60_000
  const b = advanceMood(a.mood, { now: later, lastHeardMs: later })
  assert.equal(b.mood.eventsToday, 2, `隔了 45 分钟该算第二次，实际 ${b.mood.eventsToday}`)
})

console.log('\n── 期待状态机 ───────────────────────────')
t('卡住七天 → 搁置', () => {
  const old = new Date(Date.now() - 8 * 86400000).toISOString()
  const s = { items: [{ topic: 'x', baseInterest: 0.9, stage: 'stuck', note: '', updated: old, related: [] }] }
  const r = advance(s)
  assert.equal(r.state.items[0].stage, 'shelved')
  assert.equal(r.transitions.length, 1)
})
t('进行中十四天没动静 → 搁置', () => {
  const old = new Date(Date.now() - 15 * 86400000).toISOString()
  const s = { items: [{ topic: 'x', baseInterest: 0.9, stage: 'active', note: '', updated: old, related: [] }] }
  assert.equal(advance(s).state.items[0].stage, 'shelved')
})
t('刚更新过的不动它', () => {
  const nowIso = new Date().toISOString()
  const s = { items: [{ topic: 'x', baseInterest: 0.9, stage: 'active', note: '', updated: nowIso, related: [] }] }
  assert.equal(advance(s).state.items[0].stage, 'active')
})
t('超过三条按利息截断', () => {
  const nowIso = new Date().toISOString()
  const mk = (topic, i) => ({ topic, baseInterest: i, stage: 'active', note: '', updated: nowIso, related: [] })
  const s = { items: [mk('a', 0.9), mk('b', 0.8), mk('c', 0.7), mk('d', 0.1)] }
  const r = advance(s)
  assert.equal(r.state.items.length, 3)
  assert.ok(!r.state.items.some((x) => x.topic === 'd'), '利息最低的那条该被丢')
})
t('利息按天衰减，跑多少次都一样（幂等）', () => {
  const old = new Date(Date.now() - 5 * 86400000).toISOString()
  const item = { topic: 'x', baseInterest: 1, stage: 'active', note: '', updated: old, related: [] }
  const a = effectiveInterest(item)
  const b = effectiveInterest(item)
  assert.equal(a, b)
  assert.ok(a < 1 && a > 0.8, `五天应衰减到 0.86 附近，实际 ${a.toFixed(3)}`)
})
t('抽样 80% 提主线', () => {
  const nowIso = new Date().toISOString()
  const s = {
    items: [
      { topic: 'main', baseInterest: 0.9, stage: 'active', note: '', updated: nowIso, related: [] },
      { topic: 'side', baseInterest: 0.4, stage: 'active', note: '', updated: nowIso, related: [] },
    ],
  }
  let hits = 0
  for (let i = 0; i < 500; i++) if (pickForWake(s).topic === 'main') hits += 1
  assert.ok(hits > 380 && hits < 460, `主线占比应在 80% 附近，实际 ${hits}/500`)
})
t('搁置的不会被提起', () => {
  const nowIso = new Date().toISOString()
  const s = { items: [{ topic: 'z', baseInterest: 0.9, stage: 'shelved', note: '', updated: nowIso, related: [] }] }
  assert.equal(pickForWake(s), null)
})

console.log('\n── 加权抽签 ─────────────────────────────')
t('偏向他常在的小时', () => {
  const base = dayStartMs(new Date(2026, 9, 26))
  // 只让 21 点有权重
  const w = new Array(24).fill(0.01)
  w[21] = 100
  let hits = 0
  for (let i = 0; i < 400; i++) {
    const t = pickWakeTimes(base, 1, Math.random, w)[0]
    if (new Date(t).getHours() === 21) hits += 1
  }
  assert.ok(hits > 300, `权重压到 21 点后命中应该很多，实际 ${hits}/400`)
})
t('没有权重时退回均匀（不退化成 0）', () => {
  const base = dayStartMs(new Date(2026, 9, 26))
  const set = new Set()
  for (let i = 0; i < 60; i++) set.add(new Date(pickWakeTimes(base, 1, Math.random, null)[0]).getHours())
  assert.ok(set.size > 3, `null 权重应该能抽到多个小时，实际 ${set.size}`)
})

console.log('\n── 任务账本（铁律 5）─────────────────────')
t('assigned 和 self 分开算', () => {
  const s = {
    items: [
      { topic: 'a', origin: 'assigned', state: 'doing', note: '', updated: '' },
      { topic: 'b', origin: 'assigned', state: 'done', note: '', updated: '' },
      { topic: 'c', origin: 'self', state: 'todo', note: '', updated: '' },
    ],
  }
  assert.deepEqual(assignedOpen(s).map((x) => x.topic), ['a'])
  assert.deepEqual(selfOpen(s).map((x) => x.topic), ['c'])
})
t('blocked / failed 也算「还没交代清楚」', () => {
  const s = {
    items: [
      { topic: 'a', origin: 'assigned', state: 'blocked', note: '文件被占用', updated: '' },
      { topic: 'b', origin: 'assigned', state: 'failed', note: '', updated: '' },
    ],
  }
  assert.equal(assignedOpen(s).length, 2)
  const txt = taskLines(s).join('\n')
  assert.ok(txt.includes('必须给个交代'))
  assert.ok(txt.includes('文件被占用'))
})
t('没有 assigned 时不说那段', () => {
  const s = { items: [{ topic: 'c', origin: 'self', state: 'todo', note: '', updated: '' }] }
  const txt = taskLines(s).join('\n')
  assert.ok(!txt.includes('必须给个交代'))
  assert.ok(txt.includes('可以拖着'))
})
t('状态里没有「放弃」这个出口', () => {
  assert.ok(!TASK_STATES.includes('abandoned'))
  assert.ok(!TASK_STATES.includes('dropped'))
  assert.deepEqual(TASK_STATES, ['todo', 'doing', 'done', 'blocked', 'failed'])
})

console.log('\n── 工作区观察（L1）──────────────────────')
t('能扫到最近动过的文件，且形状对', () => {
  const hits = recentChanges(PATHS.workspace, { hours: 72, limit: 5, depth: 2 })
  assert.ok(Array.isArray(hits))
  assert.ok(hits.length > 0, '刚改过这么多文件，72 小时内总该有东西')
  for (const h of hits) {
    assert.equal(typeof h.rel, 'string')
    assert.ok(!h.rel.includes('\\'), '路径要统一成正斜杠')
    assert.equal(typeof h.mtime, 'number')
  }
  assert.ok(hits.length <= 5, '要遵守 limit')
})
t('按时间倒序', () => {
  const hits = recentChanges(PATHS.workspace, { hours: 72, limit: 6, depth: 2 })
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].mtime >= hits[i].mtime)
})

console.log('\n── 措辞层（变体 / 深夜 / 月记）───────────')
t('变体是确定的：同一趟永远同一句', () => {
  const a = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 1, total: 3 })
  const b = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 1, total: 3 })
  assert.equal(a, b)
})
t('深夜切成短版', () => {
  const late = new Date(2026, 9, 26, 22, 30)
  const text = buildWakeText({ now: late, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(text.includes('不早了'))
  assert.ok(!text.includes('其余的都可做可不做'))
  assert.ok(text.includes('写完就睡'))
})
t('白天不是短版', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(!text.includes('写完就睡'))
})
t('一趟只有一件必须做的事', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(text.includes('只有一件事是必须的'))
  assert.ok(text.includes('其余的都可做可不做'))
})
t('工作区变化写成素材，不是汇报', () => {
  const text = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    index: 0,
    total: 1,
    changes: [{ rel: 'a/b.txt', mtime: Date.now() }],
  })
  assert.ok(text.includes('工作区里最近动过这些'))
  assert.ok(text.includes('a/b.txt'))
  assert.ok(text.includes('别当成任务'), '要让它是素材而不是任务')
  assert.ok(!text.includes('我扫描了工作区'), '不许机器味')
})
t('月初提醒写月记', () => {
  const first = new Date(2026, 10, 2, 10, 0) // 11 月 2 日，10 月月记不存在
  const text = buildWakeText({ now: first, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(text.includes('月记'))
  assert.ok(text.includes('2026-10.md'))
})
t('月中不提月记', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(!text.includes('该写上个月的月记了'))
})
t('任务段落进了提示', () => {
  const text = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    index: 0,
    total: 1,
    tasks: { items: [{ topic: '整理下载夹', origin: 'assigned', state: 'blocked', note: '两个文件被占用', updated: '' }] },
  })
  assert.ok(text.includes('他交代的事'))
  assert.ok(text.includes('整理下载夹'))
})

console.log('\n── 档案三级衰减（8 号）────────────────────')
t('三级各自的寿命', () => {
  assert.equal(TIER_TTL_DAYS.identity, Infinity)
  assert.ok(TIER_TTL_DAYS.preference > TIER_TTL_DAYS.observation)
  const now = Date.UTC(2026, 9, 26)
  const mk = (tier, daysAgo) => ({ text: 'x', tier, updated: new Date(now - daysAgo * 86400000).toISOString() })
  assert.equal(isAlive(mk('identity', 3000), now), true, 'identity 永不衰减')
  assert.equal(isAlive(mk('preference', 10), now), true)
  assert.equal(isAlive(mk('preference', 90), now), false)
  assert.equal(isAlive(mk('observation', 1), now), true)
  assert.equal(isAlive(mk('observation', 10), now), false)
})
t('没有档案时不崩', () => {
  assert.equal(typeof renderDossier(Date.now(), 1200), 'string')
})

console.log('\n── 概率行为组（7 号）────────────────────')
t('energy 低才会懒得看', () => {
  assert.equal(behaviorDice(0.9, () => 0.01).skipObservation, false, 'energy 高不该跳过观察')
  assert.equal(behaviorDice(0.1, () => 0.01).skipObservation, true, 'energy 很低 + 掷到 1% 就该跳过')
})
t('视而不见只注意到 2~3 件', () => {
  for (let i = 0; i < 20; i++) {
    const n = behaviorDice(0.5).noticeCount
    assert.ok(n >= 2 && n <= 3, `noticeCount 应在 2~3，实际 ${n}`)
  }
})
t('铁律 5：概率掐不掉交代的事', () => {
  const tasks = {
    items: [{ topic: '整理下载夹', origin: 'assigned', state: 'blocked', note: '两个文件被占用', updated: '' }],
  }
  const text = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    index: 0,
    total: 1,
    tasks,
    changes: [{ rel: 'a.txt', mtime: Date.now() }],
    dice: { skipObservation: true, noticeCount: 2, perfunctory: true },
  })
  assert.ok(text.includes('他交代的事'), 'assigned 必须照常渲染，不看骰子')
  assert.ok(text.includes('整理下载夹'))
  assert.ok(!text.includes('工作区里最近动过这些'), '观察可以被掐掉')
})
t('敷衍也不许写「今天没事」', () => {
  const text = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    index: 0,
    total: 1,
    dice: { skipObservation: false, noticeCount: 3, perfunctory: true },
  })
  assert.ok(text.includes('写短一点也行'))
  assert.ok(text.includes('「今天没事」不算写了'))
})

console.log('\n── 窗口漂移（10 号）────────────────────')
t('样本太少不漂', () => {
  assert.equal(deriveWindow(null), null)
  // 24 格各 0.1，合计 2.4 < minSamples(8) → 不漂
  assert.equal(deriveWindow(new Array(24).fill(0.1)), null)
})
t('他的活动分布均匀 → 窗口开得很宽，不是缩成一条缝', () => {
  const win = deriveWindow(new Array(24).fill(1))
  assert.ok(win, '有数据就该给出窗口')
  const s = Number(win.start.slice(0, 2))
  const e = Number(win.end.slice(0, 2))
  assert.ok(e - s >= 12, `均匀分布不该窄于 12 小时，实际 ${win.start}–${win.end}`)
})
t('集中在白天 → 窗口落在白天', () => {
  const w = new Array(24).fill(0.1)
  for (const h of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) w[h] = 5
  const win = deriveWindow(w)
  assert.ok(win, '应该漂出一个窗口')
  const s = Number(win.start.slice(0, 2))
  const e = Number(win.end.slice(0, 2))
  assert.ok(s >= 6 && s <= 11, `起点应在早上，实际 ${win.start}`)
  assert.ok(e >= 19 && e <= 23, `终点应在晚上，实际 ${win.end}`)
  assert.ok(e - s >= 4, '窗口至少 4 小时')
})
t('漂出来的窗口能被抽签用', () => {
  const base = dayStartMs(new Date(2026, 9, 26))
  const win = { start: '20:00', end: '23:00' }
  for (let i = 0; i < 40; i++) {
    const t = pickWakeTimes(base, 1, Math.random, null, win)[0]
    const h = new Date(t).getHours()
    assert.ok(h >= 20 && h < 23, `应该落在 20–22，实际 ${h}`)
  }
})

console.log('\n── 误解（11 号，置信度门控）──────────────')
t('置信度 >= 0.5 一律不许说出口', () => {
  assert.equal(phraseBelief({ text: 'x', confidence: 0.5 }), null)
  assert.equal(phraseBelief({ text: 'x', confidence: 0.9 }), null)
  assert.equal(phraseBelief({ text: 'x', confidence: 0.4 }), '我猜——x')
})
t('陌生的新目录才猜，提过的不猜', () => {
  const now = Date.now()
  const dirs = [{ name: '灵溪插件', mtime: now }]
  const b = buildBelief({ dirs, knownTopics: [], now })
  assert.ok(b, '应该能猜')
  assert.ok(b.confidence < 0.5)
  const skip = buildBelief({ dirs, knownTopics: ['灵溪插件'], now })
  assert.equal(skip, null, '期待/任务里提过的目录不该再猜')
})
t('名字泛的目录不猜', () => {
  const now = Date.now()
  for (const n of ['tmp', 'test', '新建文件夹', 'src']) {
    assert.equal(buildBelief({ dirs: [{ name: n, mtime: now }], now }), null, `${n} 不该猜`)
  }
})
t('有 manifest 的目录不猜（当天猜错的那次回归）', () => {
  const now = Date.now()
  // 2026-10-26：它把当天我们自己搭的 lingxi-companion 猜成「你开了个新东西」
  const b = buildBelief({ dirs: [{ name: 'lingxi-companion', mtime: now, manifest: true }], now })
  assert.equal(b, null, '带 package.json / README 的是正经工程，不是随手开的新东西')
  // 没有 manifest 的照猜
  const c = buildBelief({ dirs: [{ name: '随手建的', mtime: now, manifest: false }], now })
  assert.ok(c, '空壳目录仍可猜')
})
t('一天最多一条', () => {
  const now = Date.now()
  const dirs = [{ name: '新项目', mtime: now }]
  assert.equal(buildBelief({ dirs, lastBeliefAt: now - 3600_000, now }), null, '刚猜过就别再猜')
  assert.ok(buildBelief({ dirs, lastBeliefAt: now - 25 * 3600_000, now }), '隔一天可以再猜')
})
t('提示里以「不确定」形式出现', () => {
  const text = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    index: 0,
    total: 1,
    belief: phraseBelief({ text: '你像是开了个新东西', confidence: 0.4 }),
  })
  assert.ok(text.includes('（不太确定）'))
  assert.ok(text.includes('我猜——'))
  assert.ok(text.includes('不许说成确定的事'))
})

console.log('\n── L2 能力段（9 号，提示词级）────────────')
t('写着能自己做什么、以及写操作上限', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(text.includes('你能自己动手，不用问'))
  assert.ok(text.includes('灵溪日记/'))
  assert.ok(text.includes(`写操作一天以 ${C.DAILY_WRITE_BUDGET} 次为限`))
})
t('措辞是「分寸」不是「系统禁止」', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(text.includes('你自己该有的分寸'))
  assert.ok(!text.includes('系统禁止'), '别写成硬闸的口吻 —— 硬闸在 preset 里')
})

console.log('\n── 无意识：情绪噪声 / 闪回 / 梦 ───────────')
t('换天时会有无因波动', () => {
  const m = { affinity: 0.5, baseEnergy: 0.6, energyDay: '2026-10-25', eventsToday: 0, affinityDay: null, lastInteraction: null }
  const hi = advanceMood(m, { now: new Date(2026, 9, 26, 10).getTime(), rng: () => 0.99 })
  const lo = advanceMood(m, { now: new Date(2026, 9, 26, 10).getTime(), rng: () => 0.01 })
  assert.notEqual(hi.energy, lo.energy, '同一天同样的输入，不同随机数应该给出不同的值')
})
t('无因低落：掷到了就会明显掉一截', () => {
  const m = { affinity: 0.5, baseEnergy: 0.9, energyDay: '2026-10-25', eventsToday: 0, affinityDay: null, lastInteraction: null }
  // 第一次调用（0.5）→ 波动中性；第二次（0.01）→ 命中低落
  let n = 0
  const rng = () => (n++ === 0 ? 0.5 : 0.01)
  const r = advanceMood(m, { now: new Date(2026, 9, 26, 10).getTime(), rng })
  assert.ok(r.energy < 0.85, `应该掉下来，实际 ${r.energy}`)
})
t('闪回只从两天以前的日记里抽', () => {
  const fb = pickFlashback(new Date())
  // 现有机只有今天的日记 → 抽不到，返回 null
  assert.ok(fb === null || typeof fb.text === 'string')
  if (fb) assert.ok(fb.text.length >= 8)
})
t('夜里才提梦，白天不提', () => {
  const night = new Date(2026, 9, 26, 22, 30)
  const day = new Date(2026, 9, 26, 15, 0)
  const a = buildWakeText({ now: night, plan: { skip: false }, daysSinceHeard: 1, offerDream: true })
  const b = buildWakeText({ now: day, plan: { skip: false }, daysSinceHeard: 1, offerDream: true })
  assert.ok(a.includes('写成梦'))
  assert.ok(a.includes('不写也行'))
  assert.ok(!b.includes('写成梦'), '白天不该提梦')
})
t('梦写在自己的目录里，且不进事实层', () => {
  const text = buildWakeText({ now: new Date(2026, 9, 26, 23, 0), plan: { skip: false }, daysSinceHeard: 1, offerDream: true })
  assert.ok(text.includes('灵溪日记/梦/2026-10-26.md'))
})

console.log('\n── 学习曲线：判卷 / 脚手架 / 踩坑 ─────────')
t('判卷是纯机械的', () => {
  assert.equal(gradeDiary(null).ok, false)
  assert.equal(gradeDiary('').ok, false)
  assert.equal(gradeDiary('2026-10-26\n\n今天没事').ok, false)
  assert.equal(gradeDiary('2026-10-26\n\n—— 总结 ——\n今天没事').ok, false, '只写没事不算')
  const short = '2026-10-26\n\n—— 总结 ——\n' + '今天写了点东西。'.repeat(3)
  assert.equal(gradeDiary(short).ok, false, '太短不算')
  const good =
    '2026-10-26\n\n—— 总结 ——\n' +
    '上午把插件拆了重做，改了七个模块，判卷改成纯字符串检查，不经过模型。'.repeat(3)
  assert.equal(gradeDiary(good).ok, true)
})
t('连续合格五次要撤一条脚手架（阈值关系）', () => {
  assert.ok(C.SCAFFOLD_OK_TO_DROP >= 3, '撤得太快不稳')
  assert.ok(C.SCAFFOLD_MISS_TO_RESTORE >= 1 && C.SCAFFOLD_MISS_TO_RESTORE < C.SCAFFOLD_OK_TO_DROP)
  // 判卷标准：正文去掉标点后要够 80 字
  const enough =
    '2026-10-26\n\n—— 总结 ——\n' +
    '上午把插件拆了重做，改了七个模块，判卷改成纯字符串检查，一个字都不问模型，这样她才不会学会表演给考官看。'.repeat(2)
  assert.equal(gradeDiary(enough).ok, true)
})
t('撤掉的脚手架会让提示变短', () => {
  const full = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1 })
  const lean = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    scaffold: { dropped: ['diaryFormat', 'extraHints', 'toolsBlock'], toolFails: {}, beliefs: [] },
  })
  assert.ok(lean.length < full.length, `撤掉后应该更短：${lean.length} vs ${full.length}`)
  assert.ok(lean.includes('照老样子写'), '撤了格式也要留一句底线')
  assert.ok(!lean.includes('你能自己动手'), 'L2 段也该撤掉')
})
t('工具失败会点名', () => {
  const lines = toolFailLines({ toolFails: { 'rg --json': 3, 'git push': 1 } })
  assert.ok(lines.join('\n').includes('rg --json'))
  assert.ok(lines.join('\n').includes('别再原样撞一次'))
})
t('猜错了会被记住、而且不再猜第二次', () => {
  const now = Date.now()
  const skill = {
    beliefs: [{ dir: '旧目录', at: new Date(now - 10 * 86400000).toISOString(), wrong: false }],
    toolFails: {},
  }
  const after = resolveBeliefs(skill, [{ name: '旧目录', mtime: now - 10 * 86400000 }], now)
  assert.equal(after.beliefs[0].wrong, true, '十天没动过 → 判为猜错')
  assert.ok(guessedDirs(after).includes('旧目录'), '猜过的目录要进排除表')
  assert.ok(wrongBeliefLines(after).join('\n').includes('旧目录'))
})

console.log('\n── 召回层（recency 加权）──────────────────')
t('权重按天衰减，但不是断崖', () => {
  const w0 = recallWeight(0)
  const w3 = recallWeight(3)
  const w7 = recallWeight(7)
  const w14 = recallWeight(14)
  assert.equal(w0, 1)
  assert.ok(w3 > 0.55 && w3 < 0.7, `三天前应约 0.61，实际 ${w3.toFixed(3)}`)
  assert.ok(w7 > 0.25 && w7 < 0.4, `一周前应约 0.32，实际 ${w7.toFixed(3)}`)
  assert.ok(w14 > 0.05, `两周前不该归零，实际 ${w14.toFixed(3)}`)
  assert.ok(recallWeight(30) > 0, '一个月前还有一点点余量，不是硬截断')
})
t('被想起过的更牢', () => {
  assert.ok(recallWeight(5, 3) > recallWeight(5, 0), 'hits 高的权重要更高')
})
t('touchRecall 累加命中次数', () => {
  const a = touchRecall({}, '2026-10-24', 1000)
  assert.equal(a['2026-10-24'].hits, 1)
  const b = touchRecall(a, '2026-10-24', 2000)
  assert.equal(b['2026-10-24'].hits, 2)
  assert.equal(b['2026-10-24'].lastAccess, 2000)
})
t('只排除今天和昨天 —— 现在只有一份日记，抽不到', () => {
  // 现有日记只有 2026-10-26 当天那份，按规则 daysAgo < 2 不进池子
  const r = recallOne({ now: new Date(2026, 9, 26, 20, 0), recall: {} })
  assert.equal(r, null)
})
t('提示里召回和闪回分开写', () => {
  const text = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    index: 0,
    total: 1,
    recalled: { key: '2026-10-22', text: '那天他说要改 clock.js', daysAgo: 4 },
    flashback: { text: '怪生疏的' },
  })
  assert.ok(text.includes('前几天记的（10-22）'))
  assert.ok(text.includes('那天他说要改 clock.js'))
  assert.ok(text.includes('不知道为什么'))
  assert.ok(text.indexOf('不知道为什么') < text.indexOf('前几天记的'), '闪回在前、召在后')
})

console.log('\n── 一个灵溪，两条通道 ────────────────────')
t('切节：只取指定的那一节', () => {
  const diary = [
    '2026-10-26',
    '—— 白天 ——',
    '改了七个模块，自检 101 项。',
    '—— 总结 ——',
    '今天把插件拆了重做，累但值得。',
    '—— 给他 ——',
    '明天再说。',
  ].join('\n')
  assert.equal(extractSection(diary, '总结').includes('拆了重做'), true)
  assert.equal(extractSection(diary, '总结').includes('改了七个模块'), false, '不该串到白天节')
  assert.equal(extractSection(diary, '白天').includes('自检 101 项'), true)
  assert.equal(extractSection(diary, '不存在'), null)
})
t('判卷只看总结节 —— 白天账不能替她判及格', () => {
  const mixed =
    '—— 白天 ——\n' + '这是一段很长的流水账，全是主会话写的。'.repeat(10) + '\n—— 总结 ——\n今天没事\n'
  const g = gradeDiary(mixed)
  assert.equal(g.ok, false, '白天节再长也不能替总结节过关')
})
t('白天账已退役：不再注入提示', () => {
  const text = buildWakeText({
    now: now0,
    plan: { skip: false },
    daysSinceHeard: 1,
    index: 0,
    total: 1,
    dayLog: '19:12 重做成 workspace bundle。',
  })
  // 融合成一条时间线后，没有「第二个书房」，这一块自然失效
  assert.ok(!text.includes('白天（他在书房那边）'))
  assert.ok(!text.includes('「—— 白天 ——」那一节'))
})
t('白天账文件还读得到（留作历史）', () => {
  assert.equal(typeof todayLog(new Date()), 'string')
  assert.equal(todayLog(new Date(2030, 0, 1)), null, '那天没有记录就该是 null')
})

console.log('\n── 配置自洽 ─────────────────────────────')
t('硬编码值没被改成离谱的东西', () => {
  assert.equal(C.SPEAKS_PER_DAY, 3) // 2026-10-26 阿锦定：每天 3 次开口（= 3 个新会话）
  assert.equal(C.TICK_MS, 60000)
  assert.ok(C.SILENT_AFTER_DAYS < C.SILENT_STOP_DAYS)
  assert.ok(C.COOLDOWN_MS > 60000)
})
t('工作区路径解析出来了', () => {
  assert.ok(PATHS.workspace.includes('default-workspace'))
  assert.ok(PATHS.diaryDir.endsWith('灵溪日记'))
})

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══\n`)
process.exit(fail === 0 ? 0 : 1)
