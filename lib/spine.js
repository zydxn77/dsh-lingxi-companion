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
 * 她的工作会话 id（2026-11-05，他定的「换会话」）。
 *
 * 为什么要有这一刀：唤醒提示必然是一条 `user/message`，DSH 没有隐身投递。
 * 所以她干活的地方和「她对他说话」的地方得分开 —— 这里是她干活的那间。
 * `lingxi-20261026-1` 那种他打开看的会话，从此不再接唤醒提示。
 *
 * 会话不存在时由插件自己造一个空白的（只有 header + 三条基础事件），
 * 下一次 prompt 会把它恢复起来。造得出来的前提：会话根目录能扫到。
 */
export const WORK_SESSION_ID = 'lingxi-work'

/**
 * 她主动说话投的那间（2026-11-05 晚，他提的「两个会话」）。
 *
 * 工作会话只收唤醒提示；这间只收她的外发箱 —— 他打开它，看到的是她的话。
 * 两间都从同一套空白会话模板造，互不干扰。
 */
export const SAY_SESSION_ID = 'lingxi-say'

/**
 * 每趟唤醒一个新会话（2026-11-05，他定的「提示不进会话历史」）。
 *
 * 为什么：提示是 `user/message`，投进会话就进了历史，下一趟请求要把所有旧提示
 * 一起带上。同一间会话里已经压了 121 条旧提示。一趟一间，历史就只有这一趟。
 *
 * id 带时间戳，天然唯一；`seq` 只是同一秒内再防一层撞车。
 */
let wakeSeq = 0
export function makeWakeSessionId(now = new Date(), seq = wakeSeq++) {
  const p = (n) => String(n).padStart(2, '0')
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `lingxi-wake-${d}-${t}-${String(seq % 1000).padStart(3, '0')}`
}

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

/** 会话文件路径 → 会话 id（就是它的父目录名） */
function ownIdFromPath(p) {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

/**
 * 造一个空白会话（2026-11-05）。
 *
 * 为什么手写而不用 API：插件的 `ctx.sessionController` 只有 prompt / fork，
 * 建会话那条在 gateway 的 `session/create` 上，插件够不着。
 * 格式照抄现有会话的头两帧 —— 只有 header 和三条基础事件，没有 turn。
 *
 * 每帧都是独立的 zstd，帧与帧首尾相接（DSH 就是这么逐帧追加的）。
 */
function writeBlankSession(dir, id, cwd) {
  const now = Date.now()
  const frames = [
    JSON.stringify({
      type: 'session',
      version: 4,
      id,
      createdAt: now,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    }),
    [
      { type: 'permission/preset', seq: 0, time: now, data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', seq: 1, time: now, data: { mode: 'workspace-write' } },
      { type: 'approval/policy', seq: 2, time: now, data: { policy: 'ask' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  ]
  const buf = Buffer.concat(frames.map((f) => zlib.zstdCompressSync(Buffer.from(f + '\n', 'utf8'))))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, SESSION_FILE_NAME), buf)
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
  const ready = new Set()

  /**
   * 指定 id 的会话在不在；不在就造一个空白的。
   * 只认传进来的那一间 —— 不再「挑 lingxi-* 里最新的那个」。
   */
  function ensureSession(id) {
    if (ready.has(id)) return
    const hit = scanSessions(sessionsDir, (p) => ownIdFromPath(p) === id)
    if (!hit) {
      // 会话根目录：从任意一间她的会话往上退两层（sessions/<工作区>/<会话>/文件）
      const any = scanSessions(sessionsDir, (p) => isOwnSessionPath(p, sessionPrefix))
      if (!any) throw new Error('找不到会话根目录，建不了会话')
      const root = path.dirname(path.dirname(any.p))
      const header = readSessionHeader(any.p)
      writeBlankSession(path.join(root, id), id, header?.cwd || process.cwd())
      log(`会话不存在，造了一个空白的：${id}`)
    }
    ready.add(id)
  }

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
    async say({ text, requestId, signal, ownSession = false, ownOnly = false, saySession = false, freshWake = false }) {
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
      if (saySession) {
        // 2026-11-05：她的话投她自己的「说话」会话，不投他的会话。
        try {
          ensureSession(SAY_SESSION_ID)
          sessionId = SAY_SESSION_ID
          log(`会话路由：她的话投 ${SAY_SESSION_ID}`)
        } catch (e) {
          log(`会话路由：说话会话没备好（${String(e && e.message ? e.message : e)}）`)
          if (ownOnly) return null
        }
      } else if (wantOwn) {
        // 2026-11-05：每趟一个新会话（freshWake），提示不进累积的历史。
        //   没有 freshWake 的老调用方仍然投固定的工作会话。
        try {
          const id = freshWake ? makeWakeSessionId() : WORK_SESSION_ID
          ensureSession(id)
          sessionId = id
          log(`会话路由：投她的唤醒会话 ${id}`)
        } catch (e) {
          log(`会话路由：唤醒会话没备好（${String(e && e.message ? e.message : e)}）`)
          if (ownOnly) return null
          log('会话路由：退回主会话')
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
        // 她自己的会话（唤醒 / 说话）不参与「重认主会话」——投不进去就是投不进去，别拿他的话顶。
        if (wantOwn || saySession) throw e
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
