/**
 * speak.js —— 她开口出声的最小通道。
 *
 * 宪法口径（2026-11-06 他批准做这条线时定下）：
 *   · 这是**能力**，不是行为 —— 只提供「文本 → 合成 → 播放」，不判断什么时候该说。
 *     说什么、说不说，是她（会话里的 agent）的事。
 *   · 不进唤醒提示、不自动念日记/摘要、不留状态。
 *
 * 平台：Windows + qwen3tts-headless（J 盘 ComfyUI 自带解释器）。
 *   合成固定开销 15-20s（1.7B 进显存）+ 音频时长 4-5 倍 —— 是「留声」不是实时对话。
 *   GPU 忙碌（生图/游戏）时会慢或失败，失败就直说，绝不重试着吵他。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 合成器路径。全部可用环境变量覆盖，别处不用改代码。 */
const PY = process.env.LINGXI_TTS_PYTHON || 'J:\\ComfyUI-aki-v3\\python\\python.exe'
const RUNNER = process.env.LINGXI_TTS_RUNNER || 'J:\\ComfyUI-aki-v3\\qwen3tts-headless\\qwen3-tts-headless.py'
const OUT_DIR = process.env.LINGXI_TTS_OUT || 'J:\\ComfyUI-aki-v3\\qwen3tts-headless\\out\\lingxi'
/** 默认音色：她自己的。 */
export const DEFAULT_VOICE = process.env.LINGXI_TTS_VOICE || '自设陆雪琪'

/** 合成超时。固定开销 + 最长文本的余量，取宽松值。 */
const TIMEOUT_MS = 180_000
/** 文本上限：一段话足够，长篇她该写在日记里而不是念出来。 */
const MAX_CHARS = 300

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
}

/** 文件名：时间戳，避免覆盖她自己挑着听的历史。 */
function outPath() {
  ensureOutDir()
  const d = new Date()
  const two = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  return path.join(OUT_DIR, `she-${stamp}.wav`)
}

/**
 * 合成 + 播放。整段 Promise，失败直说原因。
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export function synthesize({ text, voice, play = true, log = () => {} }) {
  const t = String(text ?? '').trim()
  if (!t) return Promise.resolve({ ok: false, text: '没有要合成的话（text 是空的）' })
  if (t.length > MAX_CHARS) {
    return Promise.resolve({ ok: false, text: `太长了（${t.length} 字，上限 ${MAX_CHARS}）。长的话该写下来，念的只是开头那几句。` })
  }
  const v = String(voice || DEFAULT_VOICE)
  const wav = outPath()

  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve(r) } }
    const args = [RUNNER, 'speak', '--voice', v, '--text', t, '--language', 'chinese', '--out', wav]
    const child = spawn(PY, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ ok: false, text: `合成超时（${TIMEOUT_MS / 1000}s）。GPU 可能被别的活占着 —— 稍后再试，或看 ${OUT_DIR}。` })
    }, TIMEOUT_MS)

    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, text: `合成器起不来：${e.message}（python=${PY}）` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const saved = /已保存:\s*(\S+\.wav)\s*\((.*?)\)/.exec(out)
      if (code !== 0 || !saved) {
        finish({ ok: false, text: `合成失败（exit=${code}）。${err.trim().slice(-300) || out.trim().slice(-300)}` })
        return
      }
      const file = saved[1]
      const meta = saved[2]
      // 播放：cmd start 走系统默认播放器，异步、不等放完
      if (play) {
        try {
          const player = spawn('cmd.exe', ['/c', 'start', '', file], { stdio: 'ignore', windowsHide: true, detached: true })
          player.on('error', (e) => log('播放没起来：' + e.message))
          player.unref()
        } catch (e) {
          log('播放没起来：' + (e?.message ?? e))
        }
      }
      finish({ ok: true, text: `已合成并播放：${file}（${meta}，音色 ${v}）` })
    })
  })
}
