/**
 * 客户端半边：侧栏给「她的会话」加标记 + 换掉悬浮卡的皮。
 *
 * 写法照 `dsh-doyourweb/lib/client.js`（它是**跑着的**证据，文档不是）：
 *   · Module Loader 的 `factory(require)` 包装，路径固定 `lib/client.js`，不需要构建
 *   · 不声明模块级 `inject`（那样插件不激活），用 `ctx.inject?.(['slots'], …)`
 *   · 只 require('react')，不碰任何 @deepseek-ai 的 UI 包
 *
 * ⚠️ 2026-10-30 事故：我用一段正则删旧代码，把整个 `apply` 函数删掉了，
 *    而 `node --check` 只查语法、不查引用，所以它照样"通过"。
 *    教训：动这个文件之后要**读一遍**，别只看 check 的返回码。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lingxi-companion',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /** 与 lib/const.js 的 SESSION_PREFIX 必须一致 */
    const PREFIX = 'lingxi'
    /** 徽章里的字 */
    const MARK = '✦'

    /**
     * 行首徽章：银灰底 + 一点星光。
     *
     * 为什么做成小方块而不是一个字：字只能改颜色，**背景要改就得是个盒子**。
     */
    function LingxiMark(props) {
      const sessionId = props && (props.sessionId ?? props.id)
      if (typeof sessionId !== 'string' || sessionId.indexOf(PREFIX) !== 0) return null
      return React.createElement(
        'span',
        {
          title: '她',
          'aria-label': '她',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            marginRight: 5,
            borderRadius: 4,
            background: 'linear-gradient(135deg, #d6dae1 0%, #aeb5c0 55%, #8d95a3 100%)',
            boxShadow:
              '0 0 5px rgba(255,255,255,0.65), inset 0 0 3px rgba(255,255,255,0.9), inset 0 -1px 2px rgba(90,98,110,0.45)',
            color: '#ffffff',
            fontSize: 9,
            lineHeight: 1,
            textShadow: '0 0 3px rgba(255,255,255,0.95), 0 0 6px rgba(200,220,255,0.8)',
            verticalAlign: 'middle',
            flex: '0 0 auto',
          },
        },
        MARK,
      )
    }

    /**
     * 悬浮卡换皮：银灰磨砂底 + 星点。
     *
     * 第一次失败：只改了内层 `hoverContent`，外层黑底 + 内边距还在，
     * 看着像"银片贴在黑盒里"。这次用 `:has()` 从里往外选，把外层拆掉
     * （Electron 44 的 Chromium 支持 :has）。
     *
     * 作用范围：**所有**会话/工作区的悬浮卡 —— 那张卡是 portal 出去的，
     * CSS 没法只挑"她那一行"对应的卡。
     */
    const HOVER_CSS = `
/* ① 拆外层：选中"直接包着 hoverContent"的元素，去掉黑底与内边距 */
*:has(> [class*="hoverContent"]) {
  background: transparent !important;
  padding: 0 !important;
  border: none !important;
  box-shadow: none !important;
}

/* ② 卡本身：银灰磨砂 + 四点星光 */
[class*="hoverContent"] {
  background:
    radial-gradient(1px 1px at 18% 26%, rgba(255,255,255,0.95), rgba(255,255,255,0) 60%),
    radial-gradient(1px 1px at 72% 18%, rgba(255,255,255,0.75), rgba(255,255,255,0) 60%),
    radial-gradient(1.4px 1.4px at 44% 78%, rgba(255,255,255,0.85), rgba(255,255,255,0) 60%),
    radial-gradient(1px 1px at 86% 64%, rgba(255,255,255,0.6), rgba(255,255,255,0) 60%),
    linear-gradient(135deg, #9aa2ae 0%, #7c8492 48%, #5c636e 100%) !important;
  color: #f3f5f8 !important;
  padding: 10px 12px !important;
  border-radius: 10px !important;
  border: 1px solid rgba(226,232,240,0.35) !important;
  box-shadow:
    0 10px 26px rgba(16,20,26,0.5),
    inset 0 1px 0 rgba(255,255,255,0.4),
    inset 0 -1px 0 rgba(40,46,54,0.55) !important;
}

[class*="hoverContent"] [class*="hoverTitle"] {
  color: #ffffff !important;
  text-shadow: 0 0 6px rgba(255,255,255,0.35);
}
[class*="hoverContent"] [class*="hoverTime"],
[class*="hoverContent"] [class*="hoverStatus"],
[class*="hoverContent"] [class*="hoverPath"] {
  color: rgba(240,244,250,0.78) !important;
}
`

    /** 只插一次；HMR 重新 apply 时按 id 去重 */
    function injectHoverSkin() {
      if (typeof document === 'undefined') return
      const ID = 'lingxi-hover-skin'
      if (document.getElementById(ID)) return
      const el = document.createElement('style')
      el.id = ID
      el.textContent = HOVER_CSS
      document.head.appendChild(el)
    }

    function apply(ctx) {
      if (!ctx) return
      try {
        injectHoverSkin()
      } catch (e) {
        console.warn('[lingxi] 悬浮卡皮肤注入失败', e)
      }
      const register = (scope) => {
        if (!scope || !scope.slots) return
        try {
          scope.slots.inject('sidebar.session.row.leading', () =>
            scope.slots.register(
              {
                name: 'sidebar.session.row.leading',
                id: 'lingxi-companion-mark',
                order: 5,
              },
              LingxiMark,
            ),
          )
        } catch (e) {
          console.warn('[lingxi] 行首标记注册失败', e)
        }
      }
      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots'], register)
      } else {
        register(ctx)
      }
    }

    module.exports = { apply }
    return module.exports
  },
})
