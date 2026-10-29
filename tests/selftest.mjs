/**
 * 离线自检。不需要 DSH，不碰会话，不发任何东西。
 *
 *   node tests/selftest.mjs
 *
 * 验的是逻辑和措辞，不是「装上去能不能跑」—— 那个只能装上去看。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { localDateKey, yesterdayKey, diaryPath, PATHS, readPersona, decidePersonaOwner } from '../lib/home.js'
import { todayLog } from '../lib/daylog.js'
import { extractSection } from '../lib/text.js'
import { extractDisagreements } from '../lib/disagree.js'
import { decide, inWindow, pickWakeMs, pickWakeTimes, dayStartMs, hhmm, windowBounds } from '../lib/clock.js'
import { daysSince } from '../lib/mood.js'
import { monthKey, prevMonthKey, firstLine, buildIndexRows, monthlyDue, monthlyPrompt, summaryPath, indexPath } from '../lib/monthly.js'
import * as M from '../lib/mood.js'
import { advance, effectiveInterest, pickForWake, describe } from '../lib/expectations.js'
import { TASK_STATES, assignedOpen, selfOpen, taskLines } from '../lib/tasks.js'
import { deriveWindow } from '../lib/presence.js'
import { recallWeight, touchRecall, recallOne } from '../lib/recall.js'
import { pickFlashback } from '../lib/flashback.js'
import { recentChanges } from '../lib/workspace.js'
import { advanceFeedback, recordComplaint, quietDaysBefore } from '../lib/feedback.js'
import * as P from '../lib/profile.js'
import * as F from '../lib/facts.js'
import * as S from '../lib/style.js'
import * as R from '../lib/revision.js'
import * as B from '../lib/board.js'
import { isOwnSessionPath } from '../lib/spine.js'
import { buildPulse, buildWakeText, buildRoamText, callbackBlock, growthLines } from '../lib/prompt.js'
import * as RM from '../lib/roam.js'
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

console.log('\n── 心情层已拆除（架构 §4，2026-10-29）─────')
t('daysSince 向下取整', () => {
  const now = Date.now()
  assert.equal(daysSince(now - 3 * 86400000, now), 3)
  assert.equal(daysSince(null, now), null)
})
t('情绪/关系/熟悉度的函数一律不得再存在', () => {
  // 文档 §4：任何形式的情绪值、关系深度值、记忆层级字段 —— 删除（不得存在）。
  // 这条测试是**回归保险**：谁把状态机加回来，这里先炸。
  for (const gone of ['advanceMood', 'loadMood', 'saveMood', 'computeFreshness',
                      'behaviorBranches', 'branchLines', 'behaviorDice',
                      'bandOf', 'canSpeak', 'moodLines']) {
    assert.equal(typeof M[gone], 'undefined', `mood.js 不该再有 ${gone}`)
  }
})
t('const.js 里不该再有 freshness / affinity 常数', () => {
  for (const gone of ['FRESHNESS_TAU_MS', 'FRESHNESS_FAMILIAR', 'FRESHNESS_DISTANT',
                      'AFFINITY_BASELINE', 'AFFINITY_PER_PRESENCE_DAY', 'AFFINITY_DRIFT_PER_DAY']) {
    assert.equal(typeof C[gone], 'undefined', `const.js 不该再有 ${gone}`)
  }
})

console.log('\n── 唤醒提示 ─────────────────────────────')
const now0 = new Date(2026, 9, 26, 15, 30)
t('宿主已注入人格：唤醒提示里不再重复一份（2026-10-27 定）', () => {
  const text = buildWakeText({ now: now0, plan: { key: '2026-10-26', skip: false, speaks: 0 }, daysSinceHeard: 1 })
  // 宿主每个会话都注入 AGENTS.md；插件再说一遍就是同一段话说两次（今晚实测 1800 字）
  assert.ok(!text.includes('# 角色层'), '不该再复制一份角色层')
  assert.ok(!text.includes('北苍灵院'), '不该再复制人设正文')
  assert.ok(!text.includes('没读到人格文件'), '宿主有人格时不该报缺人设')
})

t('人格归谁注入：三条分支', () => {
  assert.equal(decidePersonaOwner({ hasAgentPersona: true, hasCorePersona: true }), 'host', '宿主优先')
  assert.equal(decidePersonaOwner({ hasAgentPersona: true, hasCorePersona: false }), 'host')
  assert.equal(decidePersonaOwner({ hasAgentPersona: false, hasCorePersona: true }), 'plugin', '宿主没有就插件顶上')
  assert.equal(decidePersonaOwner({ hasAgentPersona: false, hasCorePersona: false }), 'none')
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
  // 2026-10-27 改：额度从「义务」改成「判断」——
  //   还剩几趟要说，但必须同时说清「那不是还得再说几次」。
  assert.ok(text.includes('还剩 1 趟'), '说还剩几趟')
  assert.ok(text.includes('额度不是义务'), '额度不是义务，这句不能少')
  assert.ok(text.includes('没有就别开口'), '开口由她定')
})
t('最后一趟也把话说清：只剩 0 趟，不是"还得说 0 次"', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 2, total: 3 })
  assert.ok(text.includes('还剩 0 趟'))
  assert.ok(text.includes('额度不是义务'))
})
t('faint 档：提示里也不许开口', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 9, index: 0, total: 1 })
  // 2026-10-29 改：原来断言「faint 档提示里写『今天不必主动开口』」。
  //   那是沉默惩罚 —— 他越久不来，她越不许说话（架构 §9 明禁），已删。
  assert.ok(!text.includes('今天不必主动开口'), '不该再按沉默天数劝她别开口')
  assert.ok(text.includes('开口不开口，这一趟由你定'), '开口与否交给她判断')
})
t('多趟日：要求补写而不是重开一份', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 1, total: 3 })
  assert.ok(text.includes('别重开一份'))
})
t('不许出现旧流程残留（B站本身现在是故意的，不算残留）', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false, speaks: 0 }, daysSinceHeard: 1 })
  // 2026-10-27 改：这条原来连 'B站' / 'BV' / 'debrief' 一起禁 ——
  //   那时 B 站那条线整个被摘掉了。现在它**故意**回来了两处：
  //   「他这几天看了什么」的摘要，和 L2 里告诉她"可以自己看视频"那条命令。
  //   所以靶子换回它本来要防的东西：旧的九步流程话术。
  for (const bad of ['share.via', '主人', 'feed 选题', '夜间流程', '夜间流程走一遍', '--score', '--rank']) {
    assert.ok(!text.includes(bad), `旧流程残留：${bad}`)
  }
  // 但 B站 只能以"她自己的选项/素材"出现，不能带"你要发给谁"这类对外动作
  for (const bad of ['评论', '私信', '投币', '收藏']) {
    assert.ok(!text.includes(bad), `不该出现对外写动作：${bad}`)
  }
})
t('人设切片只取角色层，不带长期记忆（别人接入时的退路）', () => {
  const p = readPersona(99999)
  if (!p) return
  assert.ok(p.includes('# 角色层：灵溪'))
  assert.ok(!p.includes('# 长期记忆'), '人设里混进了长期记忆')
  assert.ok(!p.includes('信用卡'), '人设里混进了账本')
})
t('给她的那本要有细节，不许只写没事', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false, speaks: 0 }, daysSinceHeard: 1 })
  // 2026-10-27：日记改成 v2.3 四栏，「不许只写」那句措辞换了，改断言四栏都在
  for (const col of ['今天做了什么', '为什么', '想到什么', '想对他说什么']) {
    assert.ok(text.includes(`—— ${col} ——`), `提示里缺「${col}」栏`)
  }
  assert.ok(text.includes('今天没事'), '得提醒她「今天没事」不算写了')
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


// 2026-10-29 删：熟悉度（freshness）与行为分支（behaviorBranches）的 7 条测试。
//   理由见 lib/mood.js 顶部：那是「代码替她判断她现在是什么状态」，架构 §2 铁律 2 / §4 明令拆除。
//   留了回归保险在上面（「情绪/关系/熟悉度的函数一律不得再存在」）。

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
t('日记是提醒，不是命令（2026-10-29 第三刀）', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  // 原来这条断言「只有一件事是必须的」—— 那是祈使任务，架构 §7.4 明禁。
  //   现在只陈述日记在哪，写不写归她（§3.2）。
  assert.ok(!text.includes('必须'), '不该再有祈使的「必须」')
  assert.ok(text.includes('今天的日记在这儿'), '应当只说日记在哪')
  assert.ok(text.includes('不写也不算这一趟白醒'), '应当明说可以不写')
  assert.ok(text.includes('其余的都可做可不做'))
})

t('private 抽屉：只给路径，绝不读正文（2026-10-29 第四刀）', () => {
  const text = buildWakeText({ now: now0, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 1 })
  assert.ok(text.includes('private'), '要告诉她有这么个抽屉，否则她不知道能藏')
  // 关键保证（架构 §3.3）：prompt.js 里**根本不该有读取 private 的代码**。
  //   这比"塞一句话进去看看出不出来"更硬 —— 后者只要今天不读就永远绿。
  const src = fs.readFileSync(new URL('../lib/prompt.js', import.meta.url), 'utf8')
  assert.ok(!/readText\([^)]*privateDir/.test(src), 'prompt.js 不许 readText(PATHS.privateDir)')
  assert.ok(!/readFileSync\([^)]*privateDir/.test(src), 'prompt.js 不许直接读 private 文件')
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

console.log('\n── 窗口漂移（10 号）────────────────────')
t('样本太少不漂', () => {
  assert.equal(deriveWindow(null), null)
  // 24 格各 0.1，合计 2.4 < minSamples(8) → 不漂
  assert.equal(deriveWindow(new Array(24).fill(0.1)), null)
})
t('他的活动分布均匀 → 窗口开得很宽，不是缩成一条缝', () => {
  // 2026-10-27：默认 minSamples 提到 60（实测只有 19 个样本，样本太薄会推出 00–23 的假窗口）。
  //   这组测的是**漂移算术**，不是门槛，所以显式把门槛压回来。
  const win = deriveWindow(new Array(24).fill(1), { minSamples: 8 })
  assert.ok(win, '有数据就该给出窗口')
  const s = Number(win.start.slice(0, 2))
  const e = Number(win.end.slice(0, 2))
  assert.ok(e - s >= 12, `均匀分布不该窄于 12 小时，实际 ${win.start}–${win.end}`)
})
t('样本太薄 → 宁可不漂（默认门槛 60）', () => {
  // 24 格各 1 = 24 票，跟现在 19 个会话文件一个量级 —— 必须拒绝漂移
  assert.equal(deriveWindow(new Array(24).fill(1)), null, '24 票就敢当作息，那是噪声')
})
t('集中在白天 → 窗口落在白天', () => {
  const w = new Array(24).fill(0.1)
  for (const h of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) w[h] = 5
  const win = deriveWindow(w, { minSamples: 8 })
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
  // 2026-10-27 改：原来断言 `typeof todayLog(new Date()) === 'string'` ✗
  //   —— 那是拿真实日期当断言，昨天能过、今天必挂（白天账里只有 2026-10-26 那一节）。
  //   现在改成：今天可能是 null 也可能是字符串，但 10-26 那节必须读得出来。
  const today = todayLog(new Date())
  assert.ok(today === null || typeof today === 'string', '要么 null 要么字符串，不许抛')
  assert.equal(typeof todayLog(new Date(2026, 9, 26)), 'string', '2026-10-26 那节该读得到')
  assert.equal(todayLog(new Date(2030, 0, 1)), null, '那天没有记录就该是 null')
})




t('⑤ callback：第 2 趟接上一趟的尾，第 1 趟不提（同一天说过的话不该重说）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'))
  const file = path.join(dir, '2026-10-27.txt')
  try {
    const morning = new Date(2026, 9, 27, 9, 0)
    const afternoon = new Date(2026, 9, 27, 15, 0)
    assert.deepEqual(callbackBlock(morning, 1, file), [], '第 1 趟没有可回扣的东西')
    fs.writeFileSync(file, '2026-10-27\n\n—— 今天做了什么 ——\n写了点东西。\n\n—— 想对他说什么 ——\n我今天不太想说话。\n', 'utf8')
    assert.deepEqual(callbackBlock(morning, 1, file), [], '第 1 趟就算日记写了也不回扣')
    const got = callbackBlock(afternoon, 2, file).join('\n')
    assert.ok(got.includes('我今天不太想说话'), '第 2 趟要接住上一趟说过的话')
    assert.ok(got.includes('别再原样说一遍'))
    // 那一栏空着 → 不回扣（她本来就没说到什么）
    fs.writeFileSync(file, '2026-10-27\n\n—— 今天做了什么 ——\n写了点东西。\n', 'utf8')
    assert.deepEqual(callbackBlock(afternoon, 2, file), [])
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

console.log('\n── 配置自洽 ─────────────────────────────')
t('硬编码值没被改成离谱的东西', () => {
  assert.equal(C.TIER_DEFAULT, 3) // 2026-10-27 改名：常态档位（原 SPEAKS_PER_DAY），不再是硬上限
  assert.equal(C.TICK_MS, 60000)
  assert.ok(C.SILENT_AFTER_DAYS < C.SILENT_STOP_DAYS)
  assert.ok(C.COOLDOWN_MS > 60000)
})
t('工作区路径解析出来了', () => {
  assert.ok(PATHS.workspace.includes('default-workspace'))
  assert.ok(PATHS.diaryDir.endsWith('灵溪日记'))
})

console.log('\n── 短脉冲 / 指令 / 回响（2026-10-27 拆两段）──')
const NOW15 = new Date(2026, 9, 27, 15, 0)

t('脉冲只有一个字符，且不是空白', () => {
  const pulse = buildPulse()
  assert.equal(pulse, C.PULSE_TEXT)
  assert.equal(pulse.trim(), pulse, '不能带空白：宿主只认非空白文本')
  assert.equal([...pulse].length, 1, '多一个字就是多一个他看得见的字')
})

t('脉冲里不含任何教学内容', () => {
  const pulse = buildPulse()
  assert.ok(!/到点了|灵溪|人设|日记|收工/.test(pulse))
})

t('回响：他说过话时只给事实，不替他判「接没接」', () => {
  const got = buildWakeText({
    now: NOW15,
    plan: { skip: false },
    daysSinceHeard: 0,
    echo: { heardAfterLastWake: true, msSinceLastWake: 2 * 3600_000, msSinceHeard: 10 * 60_000 },
  })
  assert.ok(got.includes('他说过话'))
  assert.ok(got.includes('以你上下文里看到的话为准'), '内容判据归她，代码不许替她判')
  assert.ok(got.includes('代码只看得见他动没动过'))
})

t('回响：他还没开口时不索取', () => {
  const got = buildWakeText({
    now: NOW15,
    plan: { skip: false },
    daysSinceHeard: 0,
    echo: { heardAfterLastWake: false, msSinceLastWake: 5 * 3600_000, msSinceHeard: 5 * 3600_000 },
  })
  assert.ok(got.includes('还没开过口'))
  assert.ok(got.includes('别追问'), '没应不等于可以追问 —— 索取是禁忌')
  assert.ok(got.includes('轻一点'))
})

t('没有上一趟就不提回响', () => {
  const got = buildWakeText({ now: NOW15, plan: { skip: false }, daysSinceHeard: 1 })
  assert.ok(!got.includes('他说过话'))
  assert.ok(!got.includes('还没开过口'))
})

t('日记段：每趟先读今天的，路径必须还在提示里', () => {
  const key = localDateKey(NOW15)
  const got = buildWakeText({ now: NOW15, plan: { skip: false }, daysSinceHeard: 1 })
  assert.ok(got.includes(`灵溪日记/${key}.txt`), '压缩可能吃掉路径，所以每趟重给')
})

t('日记段：已有内容时给末尾，不给整份', () => {
  const got = buildWakeText({ now: NOW15, plan: { skip: false }, daysSinceHeard: 1 })
  // 今天那份是真的在写（本机），所以这里只验形态，不验内容
  assert.ok(got.includes('接着补，别重开一份、别把前面的盖掉') || got.includes('从零写'))
})

console.log('\n── 频率档位：他烦了会说话（2026-10-27 定）──')
t('没账的时候是常态档', () => {
  const f = advanceFeedback({ tier: undefined, applied: 0, complaints: [], lastTierDay: null }, NOW15)
  assert.equal(f.feedback.tier, C.TIER_DEFAULT)
  assert.equal(f.downgraded, 0)
  assert.equal(f.todayMuted, false)
})
t('一条抱怨降一档，且重复跑不会越降越低', () => {
  const day = '2026-10-27'
  const base = { tier: C.TIER_DEFAULT, applied: 0, complaints: [{ day, said: '太频繁了' }], lastTierDay: day }
  const once = advanceFeedback(base, NOW15)
  assert.equal(once.feedback.tier, C.TIER_DEFAULT - 1)
  assert.equal(once.downgraded, 1)
  // 同一本账再跑五遍 —— applied 已经记过，不该继续降
  let f = once.feedback
  for (let i = 0; i < 5; i += 1) f = advanceFeedback(f, NOW15).feedback
  assert.equal(f.tier, C.TIER_DEFAULT - 1)
})
t('同一天记两次只算一条：一晚上抱怨五遍不该降五档', () => {
  const memo = recordComplaint({ tier: 3, applied: 0, complaints: [], lastTierDay: null }, NOW15, '烦')
  const again = recordComplaint(memo, NOW15, '真的很烦')
  assert.equal(again.complaints.length, 1)
})
t('当天有抱怨 → 今天剩下的趟数作废', () => {
  const f = advanceFeedback(
    { tier: 3, applied: 0, complaints: [{ day: localDateKey(NOW15), said: '别叫了' }], lastTierDay: localDateKey(NOW15) },
    NOW15,
  )
  assert.equal(f.todayMuted, true)
})
t('连着 3 天没抱怨才回升，且只回常态、不冲上限', () => {
  // 昨天刚抱怨过 → 不回升
  const yesterday = '2026-10-26'
  const notYet = advanceFeedback(
    { tier: 1, applied: 1, complaints: [{ day: yesterday }], lastTierDay: '2026-10-26' },
    NOW15,
  )
  assert.equal(notYet.raised, false)
  assert.equal(notYet.feedback.tier, 1)

  // 三天前抱怨过（10-23），之后 24/25/26 都安静 → 回升一档
  const quiet = advanceFeedback(
    { tier: 1, applied: 1, complaints: [{ day: '2026-10-23' }], lastTierDay: '2026-10-26' },
    NOW15,
  )
  assert.equal(quietDaysBefore(NOW15, [{ day: '2026-10-23' }]), 3)
  assert.equal(quiet.raised, true)
  assert.equal(quiet.feedback.tier, 2)

  // 昨天刚抱怨 → 安静天数是 0，不回升
  assert.equal(quietDaysBefore(NOW15, [{ day: '2026-10-26' }]), 0)

  // 已经在常态或以上 → 安静也不会往上冲
  const high = advanceFeedback(
    { tier: C.TIER_DEFAULT, applied: 0, complaints: [], lastTierDay: '2026-10-26' },
    NOW15,
  )
  assert.equal(high.feedback.tier, C.TIER_DEFAULT)
  assert.equal(high.raised, false)
})
t('坏账不致命：tier 越界会被夹回来', () => {
  const f = advanceFeedback({ tier: 99, applied: 0, complaints: [], lastTierDay: null }, NOW15)
  assert.ok(f.feedback.tier <= C.SPEAKS_PER_DAY_MAX)
  const g = advanceFeedback({ tier: -5, applied: 0, complaints: [], lastTierDay: null }, NOW15)
  assert.ok(g.feedback.tier >= C.TIER_MIN)
})

console.log('\n── 人格接口：她是谁不该写死在代码里（2026-10-27 A 阶段）──')
t('lib 里除了 profile.js，非注释行不许再出现具体名字', () => {
  const dir = new URL('../lib/', import.meta.url)
  const bad = []
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    if (file === 'profile.js') continue // 唯一允许：默认档案住在这儿
    const lines = fs.readFileSync(new URL(file, dir), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const s = line.trim()
      // 注释里讲历史可以提到名字；输出到提示/路径的不许
      if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*/')) return
      if (line.includes('灵溪')) bad.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(bad, [], `这些地方该走 profile：${bad.join(', ')}`)
})

t('默认档案与默认措辞都取得到', () => {
  assert.equal(P.DEFAULT_PROFILE.name, '灵溪') // 默认就是本机这一位；别人改 profile.json
  assert.ok(P.DEFAULT_PROFILE.booksDir)
  assert.equal(P.pickCloser(P.DEFAULT_VOICE, 0), '别加戏。')
  assert.equal(P.pickOpener(P.DEFAULT_VOICE, 1), '', '第一趟不该说「今天第 1 次」')
  assert.ok(P.pickOpener(P.DEFAULT_VOICE, 2).includes('第 2 次'))
})

t('换名字不用改代码：只覆盖说了的字段', () => {
  const merged = P.mergeProfile(P.DEFAULT_PROFILE, { name: '西柚', booksDir: '她的本子' })
  assert.equal(merged.name, '西柚')
  assert.equal(merged.booksDir, '她的本子')
  assert.equal(merged.tasks, P.DEFAULT_PROFILE.tasks, '没说的字段必须保持默认')
})

t('坏的人格文件不致命：解析失败就退回默认', () => {
  assert.equal(P.mergeProfile(P.DEFAULT_PROFILE, null).name, '灵溪')
  assert.equal(P.mergeProfile(P.DEFAULT_PROFILE, '垃圾').name, '灵溪')
  assert.equal(P.mergeProfile(P.DEFAULT_PROFILE, { name: '' }).name, '灵溪', '空串不该把名字抹掉')
})

t('voice 覆盖：只改收尾，开场保持默认；坏值被清掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-voice-'))
  try {
    fs.mkdirSync(path.join(dir, '.lingxi'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.lingxi', 'voice.json'), JSON.stringify({ closers: ['这样就好。'] }), 'utf8')
    const voice = P.resolveVoice(dir)
    assert.deepEqual(voice.closers, ['这样就好。'])
    assert.equal(voice.openers.length, P.DEFAULT_VOICE.openers.length, '没说的那份保持默认')
    fs.writeFileSync(
      path.join(dir, '.lingxi', 'voice.json'),
      JSON.stringify({ closers: ['', 3, null] }),
      'utf8',
    )
    assert.deepEqual(P.resolveVoice(dir).closers, P.DEFAULT_VOICE.closers, '空台词不该进提示')
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

console.log('\n── 她走过的路：growth.md（2026-10-27 从 AGENTS.md 搬来）──')
t('只取「## 流水」之后的条目，文件头的规矩不算经历', () => {
  const text = [
    '# 她的经历（只追加）',
    '',
    '> 这条规矩不是经历',
    '- 这条也不算，因为在流水之前',
    '',
    '## 流水',
    '- 2026-09-19 建立记忆层',
    '- 2026-10-27 人格与机制解耦',
  ].join('\n')
  assert.deepEqual(growthLines(text), ['2026-09-19 建立记忆层', '2026-10-27 人格与机制解耦'])
})

t('最多 5 条，取最新的', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `- 2026-10-${String(i + 1).padStart(2, '0')} 第 ${i + 1} 条`)
  const got = growthLines('## 流水\n' + lines.join('\n'), 5)
  assert.equal(got.length, 5)
  assert.ok(got[0].includes('第 8 条'), '应该是最后五条')
  assert.ok(got[4].includes('第 12 条'))
})

t('没有这份文件就什么都不说 —— 别人接入时不带她的旧账', () => {
  assert.deepEqual(growthLines(null), [])
  assert.deepEqual(growthLines(''), [])
  assert.deepEqual(growthLines('# 标题\n只有标题，没有流水'), [])
})

console.log('\n── 来源与反刍：一手定事实，二手长品味（2026-10-27）──')
t('来源归一：没标的、写错的，一律当 interaction', () => {
  assert.equal(F.normalizeSource(undefined), 'interaction')
  assert.equal(F.normalizeSource(''), 'interaction')
  assert.equal(F.normalizeSource('WEB'), 'web')
  assert.equal(F.normalizeSource('web'), 'web')
  assert.equal(F.normalizeSource('随便写的'), 'interaction')
  assert.equal(F.isFactSource('web'), false)
  assert.equal(F.isFactSource('interaction'), true)
})

t('按来源劈开：事实留下，二手只计数', () => {
  const { facts, foreign } = F.splitBySource([
    { text: 'a', source: 'interaction' },
    { text: 'b' },
    { text: 'c', source: 'web' },
  ])
  assert.equal(facts.length, 2)
  assert.equal(foreign, 1)
  assert.deepEqual(F.splitBySource(null), { facts: [], foreign: 0 })
})




console.log('\n── 文字走势：只观测，不设阈（2026-10-27）──')
t('句子切分：中英句末标点和换行都算', () => {
  assert.deepEqual(S.splitSentences('你好。今天忙吗？\n算了'), ['你好', '今天忙吗', '算了'])
  assert.deepEqual(S.splitSentences(''), [])
  assert.deepEqual(S.splitSentences(null), [])
})

t('平均句长：空文本是 0，不是 NaN', () => {
  assert.equal(S.avgSentenceLength(''), 0)
  assert.equal(S.avgSentenceLength('三个字。'), 3)
  // 「十个字十个字」（10 字）+「五字」→ (10+5)/2 = 7.5
  assert.equal(S.avgSentenceLength('一二三四五六七八九十。一二三四五'), 7.5)
})

t('标点密度：用密度不用个数，空文本是 0', () => {
  assert.equal(S.punctuationDensity(''), 0)
  const d = S.punctuationDensity('你好，世界。')
  assert.ok(d > 0 && d < 1)
  // 同样多的标点，字数越多密度越低 —— 这是"密度"的意义
  assert.ok(S.punctuationDensity('你好，世界。') > S.punctuationDensity('你好，世界。今天天气不错啊'))
})

t('快照：形状齐全', () => {
  const s = S.styleSnapshot('今天写了一点。还有一点。', '2026-10-27')
  assert.equal(s.key, '2026-10-27')
  assert.ok(Number.isFinite(s.chars) && s.chars > 0)
  assert.equal(s.sentences, 2)
  assert.ok(s.avgSentence > 0)
  assert.ok(typeof s.at === 'string')
})

t('记账：同一天只留一条，晚的覆盖早的', () => {
  let h = S.recordStyle([], S.styleSnapshot('一句话。', '2026-10-26'))
  h = S.recordStyle(h, S.styleSnapshot('短。', '2026-10-27'))
  h = S.recordStyle(h, S.styleSnapshot('这一天写得更长一些。', '2026-10-27'))
  assert.equal(h.length, 2, '同一天不该攒两条')
  assert.equal(h[1].key, '2026-10-27')
  assert.ok(h[1].chars > 3, '应该是晚的那条覆盖了早的')
  // 按日期排好
  assert.ok(h[0].key < h[1].key)
})

t('记账：只保留最近 N 天', () => {
  let h = []
  for (let i = 1; i <= 70; i += 1) {
    h = S.recordStyle(h, S.styleSnapshot('一句话。', `2026-${String(Math.ceil(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`), 60)
  }
  assert.ok(h.length <= 60)
})

t('走势：差 2 字以内算没动，别每次都像变了', () => {
  assert.equal(S.styleTrend([]), null, '一条都没有就没有走势')
  assert.equal(S.styleTrend([S.styleSnapshot('一句话。', '2026-10-26')]), null, '只有一条也不够')

  const flat = S.styleTrend([
    { key: '2026-10-20', avgSentence: 20 },
    { key: '2026-10-25', avgSentence: 21 },
    { key: '2026-10-27', avgSentence: 21.5 },
  ])
  assert.equal(flat.dir, 'flat')

  const longer = S.styleTrend([
    { key: '2026-10-20', avgSentence: 12 },
    { key: '2026-10-25', avgSentence: 14 },
    { key: '2026-10-27', avgSentence: 26 },
  ])
  assert.equal(longer.dir, 'longer')
  assert.ok(longer.delta > 0)
})

console.log('\n── 自改白名单（2026-10-28）：能提，不能自己生效 ──')
const NOW28 = new Date(2026, 9, 28, 10, 0)

t('白名单之外的东西，连提案都进不来', () => {
  for (const target of ['persona.core', 'identity', 'behavior_rules', 'diary.original', '档位']) {
    assert.ok(R.rejectReason({ target, op: 'set', value: 'x' }), `${target} 应该被拒`)
  }
  assert.ok(R.rejectReason({ target: 'diary.detail', op: 'set', value: 'huge' }), '枚举外的值要拒')
  assert.ok(R.rejectReason({ target: 'voice.closers', op: 'set', value: 'x' }), 'op 不对要拒')
  assert.equal(R.rejectReason({ target: 'diary.detail', op: 'set', value: 'brief' }), null)
})

t('同一条换个天再提，只多记一天，不新建', () => {
  const a = R.propose({ items: [] }, { target: 'voice.closers', op: 'add', value: '先这样。' }, NOW28)
  assert.ok(a.id)
  const b = R.propose(a.store, { target: 'voice.closers', op: 'add', value: '先这样。' }, new Date(2026, 9, 29, 9, 0))
  assert.equal(b.store.items.length, 1, '同一条不该攒两份')
  assert.deepEqual(b.store.items[0].days, ['2026-10-28', '2026-10-29'])
  assert.equal(b.merged, true)
})

t('资格：两天 + 七天，缺一条都不算', () => {
  const one = R.propose({ items: [] }, { target: 'diary.detail', op: 'set', value: 'brief' }, NOW28)
  const item = one.store.items[0]
  assert.equal(R.isReady({ ...item, days: ['2026-10-28'] }, new Date(2026, 10, 20)), false)
  assert.equal(R.isReady({ ...item, days: ['2026-10-28', '2026-10-29'] }, new Date(2026, 9, 31)), false)
  assert.equal(R.isReady({ ...item, days: ['2026-10-28', '2026-10-29'] }, new Date(2026, 10, 4, 10, 1)), true)
  assert.ok(R.waitFor(item, NOW28).includes('天'))
})

t('已结案的不再推进', () => {
  const base = {
    id: 'x', target: 'diary.detail', op: 'set', value: 'brief',
    days: ['2026-10-28', '2026-10-29'], createdAt: NOW28.toISOString(),
  }
  const later = new Date(2026, 10, 10)
  assert.equal(R.isReady({ ...base, status: 'applied' }, later), false)
  assert.equal(R.isReady({ ...base, status: 'rejected' }, later), false)
  assert.equal(R.isReady({ ...base, status: 'pending' }, later), true)
})

t('落地与回退：改了能退回去', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-rev-'))
  try {
    const voicePath = path.join(dir, 'voice.json')
    const paramsPath = path.join(dir, 'params.json')
    fs.writeFileSync(voicePath, JSON.stringify({ closers: ['别加戏。', '做完就好。'] }), 'utf8')
    const ctx = { voicePath, paramsPath }

    const r = R.applyOne({ target: 'voice.closers', op: 'add', value: '先这样。' }, ctx)
    assert.equal(r.ok, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(voicePath, 'utf8')).closers, ['别加戏。', '做完就好。', '先这样。'])
    assert.deepEqual(r.old.list, ['别加戏。', '做完就好。'])

    const item = { target: 'voice.closers', status: 'applied', old: r.old }
    assert.equal(R.rollbackOne(item, ctx).ok, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(voicePath, 'utf8')).closers, ['别加戏。', '做完就好。'])

    assert.equal(R.applyOne({ target: 'voice.closers', op: 'add', value: '别加戏。' }, ctx).ok, false)
    assert.equal(R.applyOne({ target: 'voice.closers', op: 'remove', value: '没这句' }, ctx).ok, false)

    const set = R.applyOne({ target: 'diary.detail', op: 'set', value: 'brief' }, ctx)
    assert.equal(set.ok, true)
    assert.equal(JSON.parse(fs.readFileSync(paramsPath, 'utf8')).diaryDetail, 'brief')
    R.rollbackOne({ target: 'diary.detail', status: 'applied', old: set.old }, ctx)
    assert.equal(JSON.parse(fs.readFileSync(paramsPath, 'utf8')).diaryDetail, 'full')
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

t('坏账本不致命：proposals.json 写坏了当空账', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-prop-'))
  try {
    const f = path.join(dir, 'proposals.json')
    fs.writeFileSync(f, '这不是 JSON', 'utf8')
    assert.deepEqual(R.loadProposals(f).items, [])
    fs.writeFileSync(f, JSON.stringify({ items: [{ id: 1 }, null, 'x'] }), 'utf8')
    assert.deepEqual(R.loadProposals(f).items, [])
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

console.log('\n── 第一人称 + 看板（2026-10-28）──')
t('看板检查：超长条目会被点出来，索引行不算超长', () => {
  const long = '我'.repeat(60)
  const bad = B.boardIssues(`- ${long}`)
  assert.equal(bad.length, 1)
  assert.ok(bad[0].includes('超长'))

  // 带索引的长行放行 —— 「详情在 xxx.md」是它的正当写法
  const withIndex = B.boardIssues(`- ${'我'.repeat(60)}（详情在 记忆库/某件事.md）`)
  assert.equal(withIndex.length, 0)
})

t('看板检查：通篇「他」、一次称呼都没有 → 点出来', () => {
  const text = ['他今天很累。', '他在改插件。', '他不说话了。'].join('\n')
  const issues = B.boardIssues(text, { callHim: '阿锦' })
  assert.equal(issues.length, 1)
  assert.ok(issues[0].includes('阿锦'))
  // 用称呼就放行
  assert.equal(B.boardIssues('阿锦今天很累。', { callHim: '阿锦' }).length, 0)
})

t('看板检查：空文件不报错，标题/分隔线不算条目', () => {
  assert.deepEqual(B.boardIssues(''), [])
  assert.deepEqual(B.boardIssues('# 状态看板\n\n---\n> 引用\n'), [])
})

t('看板行：去掉空行、标题、引用、分隔线', () => {
  assert.deepEqual(B.boardLines('# 标题\n\n- 一条\n> 引用\n---'), ['- 一条'])
})

t('唤醒提示里：日记要求用称呼写，不是中性记录', () => {
  const text = buildWakeText({ now: NOW15, plan: { skip: false }, daysSinceHeard: 1 })
  assert.ok(text.includes('阿锦'), '提示里该出现她对他的称呼')
  assert.ok(text.includes('不要写「他」「用户」「对方」'), '要明说她不能写第三人称')
  assert.ok(text.includes('这话我能当面说出口吗'), '要给她判断汇报腔的尺子')
})

t('唤醒提示里：最后一趟要看板重写（重写不是追加）', () => {
  const last = buildWakeText({ now: NOW15, plan: { skip: false }, daysSinceHeard: 1, index: 2, total: 3 })
  assert.ok(last.includes('把看板重写一遍'))
  assert.ok(last.includes('看板可以忘，日记不许改'), '这句是原则，不能省')
  const first = buildWakeText({ now: NOW15, plan: { skip: false }, daysSinceHeard: 1, index: 0, total: 3 })
  assert.ok(!first.includes('把看板重写一遍'), '第一趟不该提重写')
})

console.log('\n── 游荡趟（2026-10-28）──')
t('游荡：一天 1–2 趟，落在窗口内，且按时间排好', () => {
  const now = new Date(2026, 9, 28, 9, 0, 0)
  let saw1 = false
  let saw2 = false
  for (let i = 0; i < 80; i++) {
    const p = RM.planRoamDay(now)
    assert.ok(p.times.length >= 1 && p.times.length <= RM.ROAM_MAX_PER_DAY)
    assert.equal(p.done, 0)
    assert.equal(p.key, '2026-10-28')
    for (const x of p.times) {
      const h = new Date(x).getHours()
      assert.ok(h >= 9 && h <= 23, `窗口外：${h} 点`)
    }
    for (let j = 1; j < p.times.length; j++) assert.ok(p.times[j] >= p.times[j - 1], '没排序')
    if (p.times.length === 1) saw1 = true
    if (p.times.length === 2) saw2 = true
  }
  assert.ok(saw1 && saw2, '两种趟数都该出现过')
})

t('游荡：到点才算，用完就不再响', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0)
  const plan = { key: '2026-10-28', times: [now.getTime() + 60000], done: 0 }
  assert.equal(RM.roamDue(plan, now).due, false, '还没到')
  const later = new Date(now.getTime() + 120000)
  const d = RM.roamDue(plan, later)
  assert.equal(d.due, true)
  assert.equal(d.index, 0)
  assert.equal(d.total, 1)
  const after = RM.markRoamDone(plan, 0)
  assert.equal(RM.roamDue(after, later).due, false, '用完了不该再响')
})

t('游荡：那段话里必须有「没有作业」和「也可以待着」', () => {
  const text = buildRoamText({ now: new Date(2026, 9, 28, 21, 30), index: 0, total: 1 })
  assert.ok(text.includes('没有作业'))
  assert.ok(text.includes('也可以就待着'), '少了这句，它又变成打卡了')
  assert.ok(text.includes('读片.mjs'))
  assert.ok(text.includes('灵溪-游荡.md'))
  assert.ok(text.includes('.bili-home'), '沙箱那个坑必须写进提示')
  assert.ok(text.length < 700, `太长了：${text.length}`)
})

console.log('\n── 月度重读（2026-10-29 第五刀，架构 §13）──')
t('月份键与上个月（跨年也对）', () => {
  assert.equal(monthKey(new Date(2026, 9, 15)), '2026-10')
  assert.equal(prevMonthKey(new Date(2026, 9, 15)), '2026-09')
  assert.equal(prevMonthKey(new Date(2026, 0, 5)), '2025-12', '一月要退回上一年')
})
t('首行：跳日期、跳栏名、只截 20 字，不概括', () => {
  const d = '2026-10-29\n\n—— 今天做了什么 ——\n阿锦把插件拆了三刀，我跟着看。\n后面还有很多'
  assert.equal(firstLine(d), '阿锦把插件拆了三刀，我跟着看。'.slice(0, 20))
  assert.equal(firstLine('2026-10-29'), '', '只有日期就没有首行')
  assert.equal(firstLine(''), '')
})
t('月度该不该做：只看 1–3 日 + 本月做过没有', () => {
  const rows = buildIndexRows()
  const s0 = { monthly: null }
  if (rows.length) {
    assert.equal(monthlyDue(new Date(2026, 9, 1, 9), s0), true, '1 日该做')
    assert.equal(monthlyDue(new Date(2026, 9, 3, 9), s0), true, '3 日还能补')
    assert.equal(monthlyDue(new Date(2026, 9, 4, 9), s0), false, '4 日就不补了')
    assert.equal(monthlyDue(new Date(2026, 9, 1, 9), { monthly: '2026-10' }), false, '本月做过了就不再叫')
  }
})
t('月度提示：只给路径，不给摘要正文', () => {
  const p = monthlyPrompt({ now: new Date(2026, 9, 1), prevSummary: null })
  assert.ok(p.includes('又到一个月了'), '措辞是他 21:05 挑的 B 版')
  assert.ok(p.includes('索引'), '要指到索引')
  assert.ok(!/写了\s*\d+\s*篇|字数|几次不同意/.test(p), '不许有统计')
})
t('monthly.js 不许读 private', () => {
  const src = fs.readFileSync(new URL('../lib/monthly.js', import.meta.url), 'utf8')
  assert.ok(!/readText\([^)]*privateDir/.test(src))
  assert.ok(!/readFileSync\([^)]*privateDir/.test(src))
})


console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══\n`)
process.exit(fail === 0 ? 0 : 1)