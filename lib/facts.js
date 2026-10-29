/**
 * 来源与反刍（2026-10-27 晚加）。
 *
 * 起因：她会自己刷内容（二手经历）。这带来一个新问题 ——
 * **二手经历能长品味，长不出关系。** 如果混着用，她就会变成"懂很多梗但不懂他"的人。
 *
 * 所以钉三条：
 *
 *   1. **每条事实带来源**：`interaction`（他给的）或 `web`（她自己看来的）。
 *      没标的老条目一律当 `interaction` —— 那是她以前跟他处出来的，不是看来的。
 *   2. **二手不进事实层**：`关于他` 里来源是 `web` 的条目，**读取时就滤掉**，
 *      不进提示。她可以拿看来的东西当引子、当解释框架，不能当"关于他的事实"。
 *   3. **反刍配额**：二手吃进 N 条还没消化（没写一条关联），下次醒来先消化再做别的。
 *
 * ⚠️ 三条的硬度不一样，别混：
 *   · 第 1、2 条是**代码强制**（滤掉就是滤掉，她改不了）；
 *   · 第 3 条是**提示级**（插件看不见她浏览了多久、看了几条，只能读她自己记的账）。
 *     所以它是"提醒 + 门槛"，不是硬闸 —— 别在文档里说成硬闸。
 */

/** 他给的：聊天、动作、他改过的文件。 */
export const SOURCE_TALK = 'interaction'

/** 她自己看来的：视频、评论、文章。 */
export const SOURCE_WEB = 'web'

/** 吃进这么多条还没消化，就该先消化。 */

/** 未知来源一律当 `interaction` —— 老条目宁可当事实，也别当"看来的"贬掉。 */
export function normalizeSource(source) {
  return String(source ?? '').trim().toLowerCase() === SOURCE_WEB ? SOURCE_WEB : SOURCE_TALK
}

/** 这条能不能进事实层。 */
export function isFactSource(source) {
  return normalizeSource(source) === SOURCE_TALK
}

/**
 * 按来源劈开。事实层的留下，二手的分出去（只计数，不进提示）。
 *
 * @param {Array<{source?:string}>} items
 * @returns {{facts:any[], foreign:number}}
 */
export function splitBySource(items) {
  const list = Array.isArray(items) ? items : []
  const facts = []
  let foreign = 0
  for (const item of list) {
    if (isFactSource(item?.source)) facts.push(item)
    else foreign += 1
  }
  return { facts, foreign }
}

/* 反刍账（rumination）已拆除 —— 2026-10-29 第二刀，架构 §12.2。
 *   原来这里按「攒够 3 条没消化」给提示，那是**数值 + 祈使任务**（§4 / §7.4 禁）。
 *   她要不要消化看来的东西，是她自己的事，不该由配额提醒。 */
