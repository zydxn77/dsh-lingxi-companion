/**
 * 客户端半边：给「她的会话」在侧栏行首加一个标记。
 *
 * 2026-10-29 晚他要的：几十条会话里，她的那两条一眼分得出来。
 *
 * 写法照 `dsh-doyourweb/lib/client.js`（它是**跑着的**证据，文档不是）：
 *   · Module Loader 的 `factory(require)` 包装，路径固定 `lib/client.js`，不需要构建
 *   · **不声明模块级 `inject`**：第一版写了 `inject = ['slots']`，结果插件没激活
 *     （宿主不保证 'slots' 是这个位置可静态声明的服务）。
 *     改成 `ctx.inject?.(['slots'], scope => …)` —— 和 doyourweb 一样，等它可用再注册。
 *   · 组件只 require('react')，不 require 任何 @deepseek-ai 的 UI 包
 *     （宿主明确说过：别把 Client 包当模块 require，会随时变）。
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
     * 行首徽章：银灰底 + 一点星光（2026-10-30 他要的）。
     *
     * 为什么做成小方块而不是一个字：字只能改颜色，**背景要改就得是个盒子**。
     * 16×16、圆角 4、银灰渐变；外面一圈淡淡的白色光晕当“星光”，
     * 里面再压一个更亮的星 —— 远景看是银灰，近看有亮点。
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
            // 银灰：左上偏亮、右下偏暗，像一块磨砂金属
            background: 'linear-gradient(135deg, #d6dae1 0%, #aeb5c0 55%, #8d95a3 100%)',
            // 星光：外发光 + 内高光
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
     * 悬浮卡换皮肤：银灰底 + 星点（2026-10-30 他要的）。
     *
     * 为什么用 CSS 注入：那张卡是宿主自己画的，12 个 slot 里没有它的座位，
     * 所以只能按**渲染出来的类名**改样式。CSS Module 会给类名加哈希，
     * 因此用 `[class*="hoverContent"]` 这种子串匹配 —— 哈希换成什么都命中。
     *
     * ⚠️ 它改的是**所有**会话/工作区的悬浮卡，不只她那张。
     *    CSS 没法只挑"她那一行"对应的卡（那张卡是 portal 出去的，不在行内）。
     */
    const HOVER_CSS = `
/* 银灰磨砂底 + 四点星光 */
[class*="hoverContent"] {
  background:
    radial-gradient(1px 1px at 18% 26%, rgba(255,255,255,0.95), rgba(255,255,255,0) 60%),
    radial-gradient(1px 1px at 72% 18%, rgba(255,255,255,0.75), rgba(255,255,255,0) 60%),
    radial-gradient(1.4px 1.4px at 44% 78%, rgba(255,255,255,0.85), rgba(255,255,255,0) 60%),
    radial-gradient(1px 1px at 86% 64%, rgba(255,255,255,0.6), rgba(255,255,255,0) 60%),
    linear-gradient(135deg, #9aa2ae 0%, #7c8492 48%, #5c636e 100%) !important;
  color: #f3f5f8 !important;
  border: 1px solid rgba(226,232,240,0.35) !important;
  box-shadow:
    0 8px 24px rgba(20,24,30,0.45),
    inset 0 1px 0 rgba(255,255,255,0.35),
    inset 0 -1px 0 rgba(40,46,54,0.5) !important;
  backdrop-filter: blur(2px);
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
      injectHoverSkin()
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
          // 留在 devtools 里：slot 名字或注册形状不对时，这里能看见
          console.warn('[lingxi] 行首标记注册失败', e)
        }
      }
      // 首选：等 slots 服务可用（doyourweb 就是这么做的）
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
