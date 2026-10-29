/**
 * 脊椎：把一段文字送进**他正在用的那个会话**。
 *
 * 融合之后这里不再开新会话 —— 她是同一个人，不该在隔壁另开一扇窗说话。
 * 插件干的事变成「往他现在这条对话里插一句」。
 *
 * 重点不是投递那一行，是**别乱叫**。三道闸仍在：
 *   1. 单飞锁（waking）—— 一次只允许一趟在飞
 *   2. sheIsBusy()  —— 看会话文件的 mtime，90 秒没动才算她干完了
 *   3. 硬冷却        —— 上次叫醒后 8 分钟内不再叫
 *
 * 原版的血泪注释：
 *   「waking 只在 prompt() 那一瞬为真；她一干就是好几分钟 ✗
 *     → 后来那个窗口的提示会把她上一趟的活顶掉（实测：只会在最晚那条里干活）」
 *   投递超时也**不是**失败的证据 —— 保留锁、只记日志、绝不重发。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * 这个会话文件是不是她自己的？
 *
 * ⚠️ 必须只看**会话目录名**（父目录），不能拿整条路径去 `includes('/lingxi')`。
 *    踩过：冒烟测试的临时目录叫 `lingxi-smoke-<pid>`，整条路径都含 "lingxi"，
 *    于是所有会话都被判成她的 —— 「他最后一次出现」永远为 null，
 *    沉默分档、亲近感、期待层全跟着废掉。这种错不报错，只是永远不动。
 *
 * 会话 id 就是 `session.v4.jsonl.zstd` 的父目录名（`lingxi` / `lingxi-20261026-1`）。
 */
export function isOwnSessionPath(p, prefix) {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  const dir = parts[parts.length - 2] ?? ''
  return dir.startsWith(prefix)
}

const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'
const MAX_SCAN = 5000

/**
 * 扫会话目录，找 mtime 最新的会话文件。
 * @param {string} root      ~/.dsh/sessions
 * @param {(relPath:string)=>boolean} match
 */
function scanSessions(root, match) {
  const stack = [root]
  let best = null
  let guard = 0
  while (stack.length && guard < MAX_SCAN) {
    guard += 1
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.name === SESSION_FILE_NAME && match(p)) {
        try {
          const mt = fs.statSync(p).mtimeMs
          if (!best || mt > best.mt) best = { p, mt }
        } catch {
          /* 文件刚被清掉，跳过 */
        }
      }
    }
  }
  return best
}

/**
 * 他最后一次出现的时刻。
 *
 * 办法：扫 sessions 目录，取**除她自己那些会话之外**最新那个文件的 mtime。
 *
 * ⚠️ 这是个近似。它只能回答「这台机器上最近有没有人在用 DSH」，
 *    分不清是他在跟主会话说话，还是另一个后台 agent 在干活。
 *    比「他回没回我那一句」可靠，也不假装知道得更多。
 */
export function findLastHeardMs(sessionsDir, ownPrefix) {
  const hit = scanSessions(sessionsDir, (p) => !isOwnSessionPath(p, ownPrefix))
  return hit ? hit.mt : null
}

/** 她最近那个会话文件的 mtime（用来判断她还在不在干） */
export function findOwnMtimeMs(sessionsDir, ownPrefix) {
  const hit = scanSessions(sessionsDir, (p) => isOwnSessionPath(p, ownPrefix))
  return hit ? hit.mt : null
}

/**
 * 认出「他正在用的那个会话」。
 *
 * 办法：会话文件的**第一帧就是 header**，里面有 `delegationDepth`。
 *   · 目录名以她的前缀开头 → 是她自己的，排掉
 *   · `delegationDepth > 0`  → 子 agent 的会话，排掉
 *   · 剩下的按 mtime 取最新 → 就是他正开着的那个
 *
 * 这比「猜最新一个」硬：子 agent 的事不会把她插进错误的房间。
 *
 * @returns {{ sessionId: string, mtime: number } | null}
 */
export function findMainSession(sessionsDir, ownPrefix, limit = 40) {
  const all = []
  const stack = [sessionsDir]
  let guard = 0

  while (stack.length && guard < MAX_SCAN) {
    guard += 1
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      if (e.name !== SESSION_FILE_NAME) continue
      const id = path.basename(path.dirname(p))
      if (id.startsWith(ownPrefix)) continue
      try {
        all.push({ id, p, mt: fs.statSync(p).mtimeMs })
      } catch {
        /* 刚被清掉 */
      }
    }
  }

  all.sort((a, b) => b.mt - a.mt)
  for (const cand of all.slice(0, limit)) {
    const h = readSessionHeader(cand.p)
    // 读不到 header 的不敢用；delegationDepth 缺省当主会话
    if (!h || h.type !== 'session') continue
    if (Number(h.delegationDepth) > 0) continue
    return { sessionId: h.id || cand.id, mtime: cand.mt }
  }
  return null
}

/** 会话文件的头（第一帧就是 header，zstdDecompressSync 只解第一帧，正好） */
function readSessionHeader(file) {
  try {
    const buf = zlib.zstdDecompressSync(fs.readFileSync(file))
    const line = buf.toString('utf8').split('\n')[0]
    const j = JSON.parse(line)
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/**
 * @param {object} p
 * @param {object} p.controller   ctx.sessionController
 * @param {string} p.sessionsDir
 * @param {string} p.sessionPrefix  她自己的会话 id 前缀（用来排掉旧的那些）
 * @param {(m:string)=>void} [p.log]
 */
export function createSpine({ controller, sessionsDir, sessionPrefix, log = () => {} }) {
  let cached = null

  function resolveMain(force = false) {
    if (cached && !force) return cached
    const hit = findMainSession(sessionsDir, sessionPrefix)
    cached = hit ? hit.sessionId : null
    return cached
  }

  return {
    sessionPrefix,
    resolveMain,

    /**
     * 往他正开着的会话里说一句。
     *
     * 融合之后**不再 create、不再 rename** —— 她是同一个人，不该另开一扇窗。
     * 这也顺带解决了「他看不见」：话就落在他正在看的这段对话里。
     *
     * requestId 仍然是必填（SessionPromptRequest 的 z.string()），
     * 也仍然是幂等键：重试不会插两条。
     */
    async say({ text, requestId, signal, ownSession = false, ownOnly = false }) {
      if (!requestId) throw new Error('say 需要 requestId（SessionPromptRequest 必填）')

      // 2026-10-27：会话路由。
      //   问题：往主会话投的是「叫醒她的指令」，他看见的是一段教学话术 ——
      //     和「她在他眼前说话」完全是两件事。
      //   但 `controller` 只有 prompt，**没有创建会话的能力**，所以只能投进已经存在的
      //     `lingxi-*` 会话（融合之前那些）。没有这样的会话就退回主会话。
      //   ⚠️ 默认**不开**：由 `.lingxi/config.json` 的 `ownSession` 决定（环境变量也能覆盖）。
      //     没验过的东西不默认生效 —— 万一 prompt 到非当前会话不真的跑起来，
      //     唤醒会静默无效，那比现在更糟。
      let sessionId = resolveMain()
      const wantOwn = ownSession || Boolean(process.env.LINGXI_OWN_SESSION && String(process.env.LINGXI_OWN_SESSION) !== '0')
      if (wantOwn) {
        const hit = scanSessions(sessionsDir, (p) => isOwnSessionPath(p, sessionPrefix))
        if (hit) {
          const parts = hit.p.replace(/\\/g, '/').split('/').filter(Boolean)
          const own = parts[parts.length - 2]
          if (own) {
            log(`会话路由：投她自己的会话 ${own}`)
            sessionId = own
          }
        } else if (ownOnly) {
          // 2026-10-27 晚定：**绝不退回他的会话**。
          //   退回就等于把一段教学话术摊在他眼前 —— 那正是要消掉的东西。
          //   她自己的会话没了，这一趟就不叫：宁可漏，不可打扰。
          log('会话路由：她自己的会话没了，这一趟跳过（不投他的会话）')
          return null
        } else {
          log('会话路由：没找到她自己的会话，退回主会话')
        }
      }
      if (!sessionId) throw new Error('找不到主会话：他这会儿没开着任何会话')

      const send = (sid) =>
        controller.prompt(
          { requestId, sessionId: sid, mode: 'queue', content: [{ type: 'text', text }] },
          signal,
        )

      try {
        await send(sessionId)
      } catch (e) {
        // 会话可能刚被换掉（他重开了）。重认一次，再试一回 —— 只重试一次。
        const again = resolveMain(true)
        if (again && again !== sessionId) {
          log(`主会话换了：${sessionId} → ${again}，重投一次`)
          sessionId = again
          await send(sessionId)
        } else {
          throw e
        }
      }
      return sessionId
    },

    /** 她还在干吗。返回 false 或一个原因字符串。 */
    busy({ busyUntil = 0, idleMs }) {
      if (Date.now() < busyUntil) return 'cooldown'
      const mt = findOwnMtimeMs(sessionsDir, sessionPrefix)
      if (mt !== null && Date.now() - mt < idleMs) return 'still-working'
      return false
    },

    /** 他最后一次出现（近似，见函数注释） */
    lastHeardMs() {
      return findLastHeardMs(sessionsDir, sessionPrefix)
    },
  }
}
