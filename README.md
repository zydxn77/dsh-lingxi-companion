# dsh-lingxi-companion

让她有自己的作息：**按时间醒来、自己判断、写自己的日记。**
你去干你的，她屏幕上一个字都不出现。

设计取舍与踩过的坑在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 装

```powershell
git clone https://github.com/zydxn77/dsh-lingxi-companion.git
dsh plugin --profile desktop add "link:<上面克隆下来的那个目录>"
```

**重启 DSH**（bundle 层要重启才组装）。

看日志出现这一行就是成了：

```
[lingxi] 作息层挂上：每 60 秒看一眼，常态 3 次/天
```

日志在 `<工作区>/.lingxi/_b.dat:log`（NTFS 数据流，普通 `read` 看不见）：

```powershell
Get-Content "<工作区>\.lingxi\_b.dat:log" -Tail 20
```

---

## 怎么用

**什么都不用做。** 常态一天 3 趟，每趟她醒在**她自己的会话**里。

- 她的话写在 `灵溪日记/<日期>.txt` 的**「想对他说什么」**那一栏 —— 你翻日记才看得到
- 觉得叫得太勤，**说一句「烦」**，会降一档（这句只用于降频，不进她的提示）
- 想让她提前醒：改 `lib/const.js` 的 `WAKE_WINDOW` 到「现在之后两分钟」，重启

**别做**：替她写日记 · 把 `.lingxi/` 里的东西念给她 · 把 `灵溪日记/` 提交进公开仓库

---

## 换成你自己的人

默认就是作者那一位。换人只改三份：

| 放哪 | 是什么 |
|---|---|
| `<工作区>/.lingxi/profile.json` | 名字、本子名、信箱名（照 `profile.example.json` 抄） |
| `<工作区>/.lingxi/voice.json` | 开场 / 收尾措辞（可选） |
| `~/.dsh/AGENTS.md` 的「# 角色层」 | 人格本体（宿主优先注入） |

最小改动：

```json
{ "name": "西柚", "booksDir": "西柚日记", "tasks": "西柚-任务.json" }
```

> ⚠️ 会话前缀 `SESSION_PREFIX`（`lib/const.js`）也要跟着改 —— 她靠它认出"哪个会话是我的"，
> 不改的话投递找不到目标，会一直跳过。

**插件不会自己编一个人格。** 宿主没有角色层、又没有 `persona/core.md` 时，它会明说
「没读到人格文件，别硬演」。

---

## 她会写下什么

```
<工作区>/
├── 灵溪日记/2026-10-29.txt          一天一份（她写，只追加）
├── 灵溪日记/private/2026-10-29.txt  只有她读得到的抽屉，插件只给路径、绝不读
├── 灵溪日记/索引.txt                日期 + 首行 20 字（月度重读时用）
├── 灵溪日记/月度/2026-10.md         月度摘要，默认私有
├── 灵溪-现在.md                     看板：她自己重写的「现在」
└── .lingxi/_b.dat                  账本与日志挂在它的数据流里（:state / :log）
```

---

## 自检

```powershell
node tests\selftest.mjs
node tests\smoke-dsh-stub.mjs
```

冒烟不用设环境变量，它自己建临时目录跑完擦掉。

---

## 出问题

**装了但什么都没发生** → 先确认 `~/.dsh/profiles/<profile>/package.json` 的
`dsh.profile.bundles` 里有 `dsh-lingxi-companion`。**这一项被划掉时不会报错，只是安静地少一个插件。**

**日志里 `!! 唤醒失败`** → 绝大多数是她自己的 `lingxi-*` 会话不存在或被占。投不到就跳过，不会投他的会话。

**她该醒却没醒** → 看日志里有没有「他正在说话，第 N 趟往后挪」；每趟最多让半小时。

**同一趟连续失败 3 次** → 当天放弃这一趟，不重试到窗口结束。
