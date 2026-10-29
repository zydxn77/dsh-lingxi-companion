/**
 * 常量。全部硬编码，不设配置文件、不给旋钮。
 *
 * 理由（借 dsh-bili-whale 的原话）：参数给了也不一定按填的走，那不如不给。
 * 要改就改这里 —— 一处，改完重启 DSH。
 */

/** 心跳。插件常驻，每 60 秒看一眼该不该叫她。 */
export const TICK_MS = 60_000

/**
 * 作息窗口：一天里允许醒来的时段，半开区间 [start, end)。
 * 醒来时刻在窗口内**随机**取，不是整点 —— 整点行动的是定时任务。
 */
export const WAKE_WINDOW = { start: '09:00', end: '23:30' }

/** 今天不想动的概率。掷到也照样叫醒一次，只是让她写「今天不想动」。 */
export const SKIP_CHANCE = 0.3

/** 沉默分档：距他最后一次出现 N 天。 */
export const SILENT_AFTER_DAYS = 3
export const SILENT_STOP_DAYS = 7

/** 会话文件 90 秒没动 → 认为她干完了。 */
export const IDLE_MS = 90_000

/** 上次叫醒后至少隔这么久才允许下一次（她一轮通常几分钟）。 */
export const COOLDOWN_MS = 8 * 60_000

/** 投递超时：只记一条日志，不重发、不放弃锁。 */
export const WAKE_TIMEOUT_MS = 15 * 60_000

/**
 * 常态档位：一天开几次口。
 *
 * ⚠️ 2026-10-27 改名（原 `SPEAKS_PER_DAY`）。它已经不是「每天固定几次」，
 *    而是**常态档位**：抱怨会把它压下去，连着几天没抱怨会升回来，
 *    高于常态要他明说。名字改对了，才不会有人再去写死它。
 *    真正的浮动逻辑在 `feedback.js`，这里只是基准。
 *
 * 一次开口 = 往他正开着的会话投一拍（脉冲 + pre-step 指令），
 * 每次醒来都得有一趟落脚（写日记也要）。
 */
export const TIER_DEFAULT = 3

/**
 * 会话 id 前缀 —— 这是**机制**，不是她的名字。
 *
 * 用来认出「哪些会话是她自己的」（投递路由、排掉旧会话都靠它）。
 * 它长得像 lingxi 只是因为这是她的机器；换人不影响它，改了反而会让旧会话认不出来。
 */
export const SESSION_PREFIX = 'lingxi'

/** 人设注入上限（字）。整份 AGENTS.md 有 34KB，全塞会撑爆。 */
export const PERSONA_MAX_CHARS = 3000

/** 「关于他」档案注入上限（字）。 */
export const DOSSIER_MAX_CHARS = 1200

/** 唤醒提示里「昨天日记」最多带多少字进正文（不带全文，只给路径 + 开头几行）。 */
export const YESTERDAY_HEAD_CHARS = 600

/* ── 0 号：熔断与不打搅 ───────────────────────────────────────────── */

/**
 * 同一趟连续失败几次就放弃当天这一趟。
 *
 * 没有它，失败会每轮 tick 重试到窗口结束 —— 870 分钟，最坏几百回。
 * requestId 幂等只保证不会发出两条消息，不保证不会重试几百次。
 */
export const MAX_FAILS_PER_SLOT = 3

/** 他最近 N 分钟内还在用 DSH → 这一趟往后挪，别打断。 */
export const HE_BUSY_MS = 5 * 60_000

/**
 * 但最多让他打断这么久。超过就照开。
 *
 * 没有这个上限，「他一直在用」会把她饿死一整天 ——
 * 而 lastHeard 是「除她以外最新会话文件的 mtime」，我在这头干活也算「他在用」。
 */
export const MAX_DEFER_MS = 30 * 60_000

/**
 * 游荡趟的宽容期（2026-10-28）。
 *
 * 游荡的时刻是当天随机抽的，抽出来可能已经过去了。
 * 过了这个期限就不开了 —— 一句「现在可以逛逛」如果晚到两小时，比不开更怪。
 */
export const ROAM_GRACE_MS = 60 * 60_000

/* ── 1 号：加权抽签 ──────────────────────────────────────────────── */

/**
 * 在场直方图的底数：每个小时先垫这么多，保证没有绝对死时段。
 * 垫 1 的时候，一个从没活跃过的小时仍然有小概率被抽到。
 */
export const PRESENCE_SMOOTHING = 1

/* ── 3 号：心情三维 —— 2026-10-29 按架构 §4 整段拆除 ─────────────────
 *
 * 原来这里有 FRESHNESS_TAU_MS / FRESHNESS_FAMILIAR / FRESHNESS_DISTANT
 * 和 AFFINITY_BASELINE / AFFINITY_PER_PRESENCE_DAY / AFFINITY_DRIFT_PER_DAY。
 *
 * 全删。文档 §4 写的是「删除（不得存在）」：任何形式的情绪值、关系深度值。
 * 连带 mood.js 的状态机、behaviorBranches 的行为分支、moodLines 的沉默指示一起拆了。
 *
 * 调度还需要什么，见 §11.1 的三类：时间窗口 / 上次成功开口（冷却）/ 懒日随机。
 */

/** energy 惯性：今天 = 昨天 × 0.7 + 新事件 × 0.3。 */
export const ENERGY_KEEP = 0.7
export const ENERGY_NEW = 0.3

/**
 * 隔多久才算「他又出现了一次」。
 *
 * 主会话文件的 mtime 每分钟都在动（我在这头干活也算），
 * 按「变了就 +1」会记出 `eventsToday: 17` 这种读不出任何东西的数字。
 */
export const PRESENCE_SESSION_GAP_MS = 30 * 60_000

/* ── 2 号：期待状态机 ────────────────────────────────────────────── */

/** 最多留几条。人脑不是单线程，但也不是仓库。 */
export const EXPECT_MAX = 3

/** 卡住超过这么多天 → 搁置。 */
export const EXPECT_STUCK_SHELVE_DAYS = 7
/** 进行中但这么多天没动静 → 搁置。 */
export const EXPECT_ACTIVE_SHELVE_DAYS = 14

/** 每天利息衰减（乘数）。相关东西动了就回升。 */
export const EXPECT_INTEREST_DECAY = 0.97
export const EXPECT_INTEREST_FLOOR = 0.1
export const EXPECT_INTEREST_BUMP = 0.15

/** 唤醒时提期待的抽样：80% 提主线，20% 突然想起别的。 */
export const EXPECT_MAIN_RATIO = 0.8

/* ── 4 号：措辞 ──────────────────────────────────────────────────── */

/**
 * 过了这个点（小时）就算「深夜」—— 唤醒提示切成短版，只写日记不折腾。
 * 23:30 是窗口上限，所以只有 22:00–23:30 这一小段用得上；
 * 但窗口改宽了它就自动生效，不必再动这里。
 */
export const LATE_NIGHT_HOUR = 22

/* ── 5 号：工作区观察 ────────────────────────────────────────────── */

/** 只看最近多少小时动过的文件。 */
export const CHANGES_HOURS = 24
/** 最多列几条 —— 多了就是流水账，不是「路过瞥见」。 */
export const CHANGES_LIMIT = 6
/** 递归几层。2 够看到「目录/文件」，再深就开始翻垃圾了。 */
export const CHANGES_DEPTH = 2

/* ── 11 号：误解（置信度门控）────────────────────────────────────── */

/**
 * belief 的置信度。必须 < 0.5 —— 门是代码把的：
 * `phraseBelief` 见到 >= 0.5 一律返回 null，不许确定性陈述。
 */
export const BELIEF_CONFIDENCE = 0.4

/** 一天最多一条猜测。 */
export const BELIEF_MIN_GAP_MS = 24 * 3600_000

/* ── 9 号：L2 能力（提示词级）──────────────────────────────────────── */

/**
 * ⚠️ 技术债，明写在字段上：
 *
 * 这一条是**提示词级的**，不是代码强制的 —— 与铁律 2「约束写在代码里，不写在提示词里」冲突。
 * 阿锦 2026-10-26 定的做法：L2 权限先写进提示词，等 agent preset 层落地再搬过去。
 *
 * 真正兜底的仍然是 DSH 那个会话的权限策略（preset），不是这几行字。
 * 所以这里的措辞是「你自己该有的分寸」，不是「系统禁止你」——
 * 它约束的是她的自觉，不是她的能力。别把它当闸。
 */
export const L2_ALLOWED = [
  '读工作区里的文件、看目录',
  // 2026-10-27：本子名随 profile 变，这里只留占位符（由 prompt.js 的 toolsBlock 填）。
  '写她自己的那几个本子：{books}/、{expectations}、{tasks}、{dossierJson}',
  '跑只读命令看状态（git status、ls 这类）',
  // 2026-10-27 加：他挑了一系列视频，问"能不能让她自己看"。
  //   答案是不用给她做新工具 —— 她会跑命令，那条命令本来就有。
  //   这里只把入口给她，**看不看、看哪条、看几条，她自己定**。
  //   ⚠️ 只读：这条命令只拿元信息/简介/字幕/弹幕/热评，不发任何东西。
  // 2026-10-29：原来这里写的是绝对路径（带本机用户名和 node 安装位置）。
  //   那样别人装上之后，他的提示里会印着**上一个作者的机器路径** —— 于是改成相对工作区。
  //   工作区就是会话的当前目录，所以对本机和别人都成立。
  '看 B站 视频（只读，看懂了才有得说）：`node bili-whale\\tools\\bili.mjs debrief <BV号> --no-frames`（约 7 秒一条；先 search 或让他给链接）',
]

/** 写操作一天的自觉上限。同样是提示词级，不强制。 */
export const DAILY_WRITE_BUDGET = 5

/**
 * 她投完那句之后，主会话文件的 mtime 会被**她自己**的回合写新。
 *
 * 投递是 `mode: 'queue'`（排队），所以写的时刻滞后于投递 —— 抓 mtime 比对抓不准
 * （试过，抓早了）。改成时间窗：投完之后这么多分钟内，mtime 变新一律当自己动的。
 *
 * 代价：他若在这段窗口里搭话，要等窗口过去的下一个 tick 才被认出来。
 * 沉默衰减按**天**算，晚十分钟无所谓。
 */
export const SELF_QUIET_MS = 10 * 60_000

/* ── 余额与提示音（从小鲸鱼移植）────────────────────────────────── */

/** 低于这个余额就提一句。他今天用了 8.5 元，5 元差不多是一天的量。 */
export const BALANCE_LOW = 5

/** 低于这个就是真快没了 —— 措辞会硬一点。 */
export const BALANCE_CRITICAL = 2

/** DeepSeek 余额接口（照抄小鲸鱼的 index.js:550） */
export const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/**
 * 超时 8 秒，不是 20 秒。
 * 小鲸鱼的注释写过原因：2 次尝试 + 退避必须明显短于调用方的超时，
 * 否则外层先 abort，用户永远只看到「第一次失败」。
 */
export const BALANCE_TIMEOUT_MS = 8000

/** 两次尝试之间的退避。第一次重试是专为「冷启动时凭据服务还没就绪」。 */
export const BALANCE_RETRY_MS = 500

/** 小鲸鱼的安装位置（提示音资产在它包里） */
const WHALE_ROOT = `${process.env.DSH_HOME || (process.env.USERPROFILE || '.') + '/.dsh'}/profiles/desktop/node_modules/dsh-whale-widget`

/**
 * 专属提示音。
 *
 * 用小鲸鱼那个「经验球」—— 短、轻、不吓人。
 * 别用 `cost-default.wav`（每轮消耗那个）：鲸鱼每一轮都会响，
 * 她再用同一个音，就分不出「是她」还是「随便一轮」。
 *
 * 用正斜杠拼路径，免得再引 node:path。
 */
export const SOUND_FILE = process.env.LINGXI_SOUND || `${WHALE_ROOT}/assets/minecraft-exp-orb.wav`

/** 想安静就改 false。 */
/**
 * 提示音：**默认关**（2026-10-27 改）。
 *
 * 原来写死 true，而 SOUND_FILE 指向另一个插件的资源：
 *   `…/dsh-whale-widget/assets/minecraft-exp-orb.wav`
 * 那个插件不在这台机器上 —— 于是**每次唤醒都记一行「提示音文件不存在」，从来没响过**。
 * 又一个"写了不生效"。和余额那条同一类。
 *
 * 现在：只有显式设了 `LINGXI_SOUND` 指向一个真实存在的 wav 才开。
 * 想听就自己放一个文件、设环境变量，别让它默认去打一个不存在的路径。
 */
export const SOUND_ENABLED = Boolean(process.env.LINGXI_SOUND)

/* ── 无意识：情绪噪声 ───────────────────────────────────────────── */

/**
 * 每天一次的无因波动（±这个值）。
 *
 * 为什么要它：现在的 energy / affinity 全部事件驱动，每一格都能溯源。
 * 真人不是 —— 有些天就是没来由地沉。这一项让日志里出现「找不到原因的变化」。
 */
export const MOOD_NOISE = 0.06

/** 无因低落的概率，和那天的跌幅。**不写原因** —— 那就是「不知道怎么了」。 */
export const BAD_DAY_CHANCE = 0.05
export const BAD_DAY_DROP = 0.15

/* ── 学习曲线：脚手架衰减 ───────────────────────────────────────── */

/** 连续合格几次就撤掉一条脚手架。 */
export const SCAFFOLD_OK_TO_DROP = 5
/** 连续不合格几次就把撤掉的装回去。 */
export const SCAFFOLD_MISS_TO_RESTORE = 2

/** 判卷的标准：日记正文至少这么多字才算「写了东西」。 */
export const DIARY_MIN_CHARS = 80

/**
 * 「他这几天在看什么」那份摘要，最旧能有多久（小时）。
 *
 * 2026-10-27 加。摘要由 bili-whale 的 `taste` 命令生成到 `~/.dsh/whale-brief.md`，
 * **目前没有定时**（谁跑谁新鲜）。过了这个点就当没有 —— 宁可让她不知道，
 * 也别让她拿着几天前的数据当成"他今天在看的"。陈旧的事实比没有事实更坏。
 */
export const BRIEF_MAX_AGE_HOURS = 12

/**
 * 可以撤的脚手架，按撤除顺序排。
 * ⚠️ 任务段、交代的事、「不许说成确定的事」永远不可撤 —— 不在这张表里。
 */
export const SCAFFOLD_STEPS = ['diaryFormat', 'extraHints', 'toolsBlock']

/* ── 无意识：闪回与梦 ───────────────────────────────────────────── */

/** 闪回只从这么多天以前的日记里抽（近期的事已经在昨天那份里了）。 */
export const FLASHBACK_MIN_AGE_DAYS = 2
/** 闪回一天最多一次。 */
export const FLASHBACK_MIN_GAP_MS = 20 * 3600_000

/** 过了这个点才提「梦」。 */
export const NIGHT_HOUR = 22

/* ── 误解闭环 ───────────────────────────────────────────────────── */

/**
 * 一条猜测过了这么多天、那个目录还是没再动过 → 判为「大概只是顺手建的」，
 * 记成猜错，以后不再猜它。这是全篇唯一一条「由错误变成经验」的路径。
 */
export const BELIEF_RESOLVE_DAYS = 7

/* ── 召回层（借 generative_agents 的 recency 因子）────────────────── */

/** 召回只看最近这么多天的日记，再早的不进池子。 */
export const RECALL_DAYS = 14

/** 一次唤醒最多带几段「前几天记得的」。只带一段 —— 多了又成流水账。 */
export const RECALL_LIMIT = 1

/**
 * 日衰减。
 *
 * 为什么按天不按小时：我们一天只有一份日记，按小时细分没有信息量。
 *
 * （纠正一句说过头的话：原版的 `0.995^小时` 十天后是 0.30，并没有归零 ——
 *   它的问题是尺度跟「一天一份」不匹配，不是衰减太快。`0.85^天` 两周是 0.10，
 *   两者量级其实接近，选按天只是为了跟候选集对齐。）
 */
export const RECALL_DAILY_DECAY = 0.85

/**
 * 被想起过一次的，权重抬这么多。
 *
 * 这是 generative_agents 里 `lastAccess` 的全部意思：反复被召回的更牢，
 * 一直没人碰的更快沉下去。没有这一项，recency 就退化成「永远只读最近那份」。
 */
export const RECALL_HIT_BOOST = 0.15

/* ── 短脉冲：他那边只该看见一个点（2026-10-27 定）──────────────────── */

/**
 * 投递到主会话的那条消息，正文就这一个字符。
 *
 * 为什么要有它：`SessionPromptRequest` 至少要一段非空白文本，且**没有任何字段
 * 能声明「这条不是用户说的」** —— 所以「让她自己开口」必然在他那边留一条
 * user 消息。他把话说得很清楚：那条是他的位置，不该出现教学内容。
 *
 * 于是拆成两段：这一条只用来到达并起一拍，真正给她的东西走 `agent/pre-step`
 * 的指令消息（他不渲染）。别往这里加字 —— 加一个字就是多一个他看得见的字。
 */
export const PULSE_TEXT = '·'

/* ── 频率档位：不设死数，靠「他说烦了」+ 学习（2026-10-27 定）────── */

/**
 * 一天开口的次数不再是个常数，是**档位**。
 *
 * 他原话：「没有上限时靠什么挡 —— 首先我烦了就会跟她说，之后再经过学习就会稳定下来。」
 * 所以机制是：她记下他的抱怨（一张账），代码读账算档位。
 *
 * 常态就是 `TIER_DEFAULT`（3）。抱怨一次降一档，降到底 1；
 * 连着 `TIER_RAISE_AFTER_DAYS` 天没抱怨 → 升回一档，**只回升到常态为止**。
 * 高于常态的档位只能他明说 / 手动改文件才展开 —— 否则"三天没人抱怨"会一路涨到 8，
 * 那不是学习，那是自动加速。
 */
export const TIER_MIN = 1
// TIER_DEFAULT 在上面「常态档位」那一段（原 SPEAKS_PER_DAY 的位置）—— 别重复定义
export const TIER_MAX = 8
export const TIER_RAISE_AFTER_DAYS = 3

/** 一天最多能排多少趟。只当他明说「可以多叫」时才用得上。 */
export const SPEAKS_PER_DAY_MAX = 8

/** 指令消息的来源标记。同一步里见到它就地替换，绝不堆第二份。 */
export const SCAFFOLD_SOURCE_KIND = 'lingxi-companion'

/** 指令消息的形态。只替换 directive，别的形态一律原样放过。 */
export const SCAFFOLD_FORM = 'directive'
