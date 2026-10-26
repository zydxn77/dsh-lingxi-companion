/**
 * 任务账本：交代的事走独立生命周期。
 *
 * 铁律 5 的代码落地 —— 她的事分两类，边界写死在这里：
 *
 *   origin = 'assigned'  他交代的。**没有「放弃」这个出口。**
 *                        只有 done / blocked / failed 三种终态，
 *                        而且 blocked / failed **必须**在下次开口时报出来。
 *                        完成质量可以打折（"有两处是粗排的"），汇报不可以省。
 *
 *   origin = 'self'      她自己起意的。可以拖着，可以不做，可以中途算了。
 *
 * 一句话：可靠是对承诺的，任性是对自己的。
 *
 * ⚠️ 与 mood 的关系（文档 3.5 那条）：mood 只影响 assigned 的**启动时机**
 *    （energy 低可以晚点开始），不影响**是否完成**。所以这里没有任何
 *    「按概率放弃」的分支 —— 将来加概率行为组时，必须把 assigned 排除在外。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS, readJson } from './home.js'

/** todo → doing → done / blocked / failed */
export const TASK_STATES = ['todo', 'doing', 'done', 'blocked', 'failed']
const ACTIVE_STATES = ['todo', 'doing', 'blocked', 'failed'] // blocked/failed 还没交代清楚

const STATE_LABEL = {
  todo: '还没动',
  doing: '在做',
  done: '做完了',
  blocked: '卡住了',
  failed: '没做成',
}

export function loadTasks() {
  const raw = readJson(PATHS.tasks)
  if (!raw || !Array.isArray(raw.items)) return { items: [] }
  return {
    items: raw.items
      .filter((x) => x && typeof x.topic === 'string' && x.topic.trim())
      .map((x) => ({
        topic: String(x.topic).trim(),
        origin: x.origin === 'assigned' ? 'assigned' : 'self',
        state: TASK_STATES.includes(x.state) ? x.state : 'todo',
        note: typeof x.note === 'string' ? x.note : '',
        updated: typeof x.updated === 'string' ? x.updated : new Date().toISOString(),
      })),
  }
}

export function saveTasks(t) {
  try {
    fs.mkdirSync(path.dirname(PATHS.tasks), { recursive: true })
    const tmp = PATHS.tasks + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, PATHS.tasks)
    return true
  } catch {
    return false
  }
}

/** 他交代的、还没交代清楚的（含 blocked / failed —— 那两种最该报） */
export function assignedOpen(state) {
  return state.items.filter((t) => t.origin === 'assigned' && ACTIVE_STATES.includes(t.state))
}

/** 她自己起意的、还在手里的 */
export function selfOpen(state) {
  return state.items.filter((t) => t.origin === 'self' && ['todo', 'doing'].includes(t.state))
}

export function describeTask(t) {
  const label = STATE_LABEL[t.state] ?? t.state
  return t.note ? `${t.topic}（${label}——${t.note}）` : `${t.topic}（${label}）`
}

/**
 * 拼提示里的那一段。
 *
 * 顺序有讲究：交代的事先说，而且措辞是「必须说清」——
 * 不是「你最好汇报一下」。人靠谱不在于从不出错，而在于出错时说一声。
 */
export function taskLines(state) {
  const assigned = assignedOpen(state)
  const self = selfOpen(state)
  const out = []

  if (assigned.length) {
    out.push('他交代的事：')
    for (const t of assigned.slice(0, 3)) out.push(`· ${describeTask(t)}`)
    out.push(
      '  这一趟必须给个交代：做完了 / 卡在哪 / 做不成。',
      '  质量可以打折（「有两处是粗排的」可以），不吭声不行。',
    )
  }

  if (self.length) {
    if (out.length) out.push('')
    out.push('你自己起意的事（可以拖着，这些不算承诺）：')
    for (const t of self.slice(0, 3)) out.push(`· ${describeTask(t)}`)
  }

  return out
}
