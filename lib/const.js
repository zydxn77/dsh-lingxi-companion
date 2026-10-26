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
 * 每天最多几次「主动开口」。
 *
 * 一次开口 = 她**自己开一个新会话**跟他说话。
 * 所以这个数同时也是「每天最多叫醒几次」，因为每次醒来都得有个会话落脚（写日记也要）。
 */
export const SPEAKS_PER_DAY = 3

/**
 * 会话 id 前缀。
 *
 * 每次开口建一个新会话，id 形如 `lingxi-20261026-2`。
 * 不用固定 id：固定的那种只有打开「未分组」才看得见，等于没说出口（这是上一版的毛病）。
 */
export const SESSION_PREFIX = 'lingxi'

/** 新会话的标题：他会在侧栏看见这个名字。 */
export const SESSION_TITLE_PREFIX = '灵溪'

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

/* ── 1 号：加权抽签 ──────────────────────────────────────────────── */

/**
 * 在场直方图的底数：每个小时先垫这么多，保证没有绝对死时段。
 * 垫 1 的时候，一个从没活跃过的小时仍然有小概率被抽到。
 */
export const PRESENCE_SMOOTHING = 1

/* ── 3 号：心情三维 ──────────────────────────────────────────────── */

/** freshness 的时间常数（毫秒）：3 天。freshness = exp(-Δt / TAU)。 */
export const FRESHNESS_TAU_MS = 3 * 86_400_000

/** 三条分工线的阈值 —— 低于它算「生疏」。 */
export const FRESHNESS_FAMILIAR = 0.8
export const FRESHNESS_DISTANT = 0.2

/** affinity 的基线：不往下跌，只向它缓慢回落。 */
export const AFFINITY_BASELINE = 0.5
/** 他每出现一天，亲近感 +0.02（只升）。 */
export const AFFINITY_PER_PRESENCE_DAY = 0.02
/** 长时间没互动，affinity 每天朝基线回落这么多 —— 是回落，不是惩罚。 */
export const AFFINITY_DRIFT_PER_DAY = 0.005

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
  '写她自己的那几个本子：灵溪日记/、灵溪-期待.json、灵溪-任务.json、灵溪-关于他.json',
  '跑只读命令看状态（git status、ls 这类）',
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
export const SOUND_ENABLED = true

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
