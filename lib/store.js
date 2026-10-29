/**
 * 隐藏存储（2026-10-29 第五刀，架构 §8 / §11.6）。
 *
 * 要解决的问题：她能 `read` 整台机器，而 `.lingxi/state.json` 里有"今天还剩几趟、失败几次、
 * 冷却到几点"，`.lingxi/lingxi.log` 里有每一趟投递 —— 她一旦读到，就会开始反推系统想让她怎样
 * （额度变成义务、把投递失败当成自己的失败）。架构 §8 要的是**文件层面读不到**。
 *
 * 查过宿主：DSH 只有 `read-only | workspace-write | danger-full-access` 三种沙箱模式，
 * **管写不管读**；也没有工具调用拦截钩子（`tool/call` 是调用之后的事件，`pre-tool` 只在提案里）。
 * 所以插件层面拦不住她的 `read`。
 *
 * 这里用的是 **NTFS 备用数据流（ADS）**：内容写在 `_b.dat:<名字>` 里，
 * - 列目录只看到一个 0 字节的 `_b.dat`
 * - `read` / `glob` / `grep` 都摸不到——它们按**文件**读，而流不是文件
 * - 存心用 `Get-Content -Stream` 还是读得到 —— **这一点必须记住，它不是真隔离**
 *
 * ⚠️ 它挡得住"顺手一瞥"，挡不住"存心去翻"。要绝对隔离只有另开系统账户或改宿主，
 * 那两条都已评估过、暂不采用（2026-10-29 他选的 C）。
 *
 * 回退：如果文件系统不支持 ADS（非 NTFS），自动退回普通文件，不让插件挂掉。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 宿主文件：一个 0 字节的占位，所有流都挂在它下面 */
export function storeFile(stateDir) {
  return path.join(stateDir, '_b.dat')
}

/** 某条流的完整路径（`file:stream`） */
export function streamPath(stateDir, name) {
  return `${storeFile(stateDir)}:${name}`
}

/** 普通文件路径（回退用） */
export function plainPath(stateDir, name) {
  return path.join(stateDir, `${name}.json`)
}

function fileSizeExceeds(p, limit) {
  try {
    return fs.statSync(p).size > limit
  } catch {
    return false
  }
}

/** 读一条流。没有就返回 null（**不抛**：账本坏了不该让插件起不来）。 */
export function readStream(stateDir, name, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const sp = streamPath(stateDir, name)
  try {
    if (fileSizeExceeds(sp, maxBytes)) return null
    return fs.readFileSync(sp, 'utf8')
  } catch {
    // 回退：老数据还在普通文件里
    try {
      return fs.readFileSync(plainPath(stateDir, name), 'utf8')
    } catch {
      return null
    }
  }
}

/** 写一条流。ADS 不可用时退回普通文件。返回 'ads' | 'plain' */
export function writeStream(stateDir, name, text) {
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    // 宿主文件不存在时先建一个空的 —— 流必须有宿主
    if (!fs.existsSync(storeFile(stateDir))) fs.writeFileSync(storeFile(stateDir), '')
    const sp = streamPath(stateDir, name)
    const tmp = `${sp}.tmp`
    fs.writeFileSync(tmp, text, 'utf8')
    // 流的 rename 在 Windows 上不稳，直接覆盖写（内容不大，丢了重算得出来）
    fs.writeFileSync(sp, text, 'utf8')
    try {
      fs.unlinkSync(tmp)
    } catch {}
    return 'ads'
  } catch {
    try {
      fs.writeFileSync(plainPath(stateDir, name), text, 'utf8')
      return 'plain'
    } catch {
      return 'fail'
    }
  }
}

/** 追加一行日志（日志也藏起来：里面有每一趟投递和失败原因） */
export function appendLine(stateDir, name, line, { maxLines = 800 } = {}) {
  const cur = readStream(stateDir, name) ?? ''
  const lines = cur.split('\n').filter(Boolean)
  lines.push(line)
  const keep = lines.slice(-maxLines)
  return writeStream(stateDir, name, keep.join('\n') + '\n')
}

/** 这条流现在存在在哪（诊断用：'ads' | 'plain' | 'none'） */
export function whereIs(stateDir, name) {
  try {
    fs.accessSync(streamPath(stateDir, name))
    return 'ads'
  } catch {}
  try {
    fs.accessSync(plainPath(stateDir, name))
    return 'plain'
  } catch {}
  return 'none'
}

/**
 * 挂载时自愈：如果老数据还在普通文件里（升级前留下的、或旧实例又写回来了），
 * 且它比流里的**新**，就搬进流里，然后把普通文件删掉。
 *
 * 为什么要有这一步：第五刀上线那天，旧实例在内存里还是老代码，会继续往
 * `state.json` 写普通文件 —— 不搬的话新代码读到的就是迁移那一刻的旧账。
 */
export function migratePlainIntoStreams(stateDir, names = ['state', 'log']) {
  const moved = []
  for (const name of names) {
    const plain = plainPath(stateDir, name)
    let plainText = null
    let plainMtime = 0
    try {
      plainText = fs.readFileSync(plain, 'utf8')
      plainMtime = fs.statSync(plain).mtimeMs
    } catch {
      continue
    }
    // 2026-10-29 修：**只有在流不存在时才搬**。
    //   原来的判据是"普通文件比流新就覆盖" —— 旧实例临死前写的残缺 state.json
    //   比流新，于是把完整账本盖成了 done:0（今天已做的趟数就此丢了）。
    //   教训：迁移只看"有没有"，不看"新不新"。流一旦存在就是唯一真相。
    let hasStream = false
    try {
      fs.accessSync(streamPath(stateDir, name))
      hasStream = true
    } catch {}
    if (!hasStream) {
      if (writeStream(stateDir, name, plainText) === 'ads') {
        try {
          fs.unlinkSync(plain)
        } catch {}
        moved.push(name)
      }
    } else {
      // 流已经有了：普通文件是垃圾，删掉（别让它继续泄露旧内容）
      try {
        fs.unlinkSync(plain)
      } catch {}
    }
  }
  return moved
}