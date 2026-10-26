/**
 * 误解（⑨层）—— 置信度门控版。
 *
 * ⚠️ 这是全项目最危险的一个特性，所以它最后做、而且门是**代码**把的，不是提示词把的。
 *
 * 放提示词里写「偶尔理解错一些内容」，最终一定变成乱编、错误记忆，完全失控。
 * 所以这里只允许一种最低风险的来源：
 *
 *   工作区里**新出现了一个顶层目录**，而且没有任何期待/任务提过它
 *   → 允许形成一条 belief，置信度 0.4（< 0.5 的门槛）
 *
 * 硬约束（都在代码里，商量不了）：
 *
 *   1. 只碰**结构**（目录名），绝不碰对话内容、日记内容、文件内容
 *   2. confidence 必须 < 0.5 才允许生成
 *   3. 措辞模板强制带「我猜」—— 不允许确定性陈述
 *   4. 一天最多一条（状态里记最后一条的时间）
 *   5. 它只进「素材」段，永远不进交代的事、不进任务账本
 *
 * 猜错了会怎样：她日记里延续这个猜测，哪天发现"原来搞错了"，
 * 那点小尴尬自己就发生了 —— 不需要插件造假素材。
 */
import { BELIEF_CONFIDENCE, BELIEF_MIN_GAP_MS } from './const.js'

/** 强制的不确定措辞。任何 belief 都必须走这里，不许自己拼。 */
export function phraseBelief(belief) {
  if (!belief || belief.confidence >= 0.5) return null
  return `我猜——${belief.text}`
}

/**
 * 从「新出现的目录」里挑一条能猜的。
 *
 * @param {object} p
 * @param {{name:string,mtime:number}[]} p.dirs       recentDirs() 的结果
 * @param {string[]} p.knownTopics                    期待 + 任务的 topic（提到过的就别猜）
 * @param {number} [p.lastBeliefAt]                   上一条 belief 的时间
 * @param {number} [p.now]
 * @returns {{text:string, confidence:number, dir:string}|null}
 */
export function buildBelief({ dirs, knownTopics = [], lastBeliefAt = 0, now = Date.now() }) {
  if (!dirs || !dirs.length) return null
  // 一天最多一条
  if (Number.isFinite(lastBeliefAt) && now - lastBeliefAt < BELIEF_MIN_GAP_MS) return null

  const known = knownTopics.map((t) => String(t).toLowerCase())
  for (const d of dirs) {
    const name = String(d.name)
    // 有 manifest 的目录是正经工程，不是「随手开的新东西」。
    // 这条是 2026-10-26 猜错之后加的：它把当天我们自己搭的 lingxi-companion 猜成了新东西。
    if (d.manifest) continue
    // 已经被期待/任务提过的目录不算「陌生」
    if (known.some((t) => t && (t.includes(name.toLowerCase()) || name.toLowerCase().includes(t)))) continue
    // 名字太泛的目录（tmp、test、新建文件夹）猜不出什么，跳过
    if (/^(tmp|temp|test|tests|新建文件夹|untitled|new folder|src|lib|dist|build)$/i.test(name)) continue
    return {
      text: `你最近像是开了个新东西，叫「${name}」。也可能只是顺手建的。`,
      confidence: BELIEF_CONFIDENCE,
      dir: name,
    }
  }
  return null
}
