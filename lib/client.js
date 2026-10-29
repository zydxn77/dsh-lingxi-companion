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
    const MARK = '✦'

    function LingxiMark(props) {
      const sessionId = props && (props.sessionId ?? props.id)
      if (typeof sessionId !== 'string' || sessionId.indexOf(PREFIX) !== 0) return null
      return React.createElement(
        'span',
        {
          title: '她 · 灵溪',
          'aria-label': '她',
          style: {
            color: '#b07cd8',
            marginRight: 4,
            fontSize: 11,
            lineHeight: 1,
            verticalAlign: 'middle',
            opacity: 0.95,
          },
        },
        MARK,
      )
    }

    function apply(ctx) {
      if (!ctx) return
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
