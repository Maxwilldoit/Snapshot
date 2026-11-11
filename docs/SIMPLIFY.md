# 执行步骤（按顺序，每步一个分支，做完跑检查再进下一步）

每一小步后运行：`npm test && npm run build && npm run check:i18n`，以及 `cargo fmt --check`、`cargo clippy -- -D warnings`。每步结束打开 app 截图，与改动前截图对比。

## 第一步：只删不改
1. 删死代码：`src/lib/activity.ts`、`formatWhen`、12 个未使用导出（`npx knip` 列出）；`show_main_window` 先全局确认 macOS 也未调用再删。
2. 删约 80 个未使用的 i18n key；check-i18n 增加「未引用 key 报错」。
3. 删说明文字（中英文同步）：快捷键页 “Click to set”、“These shortcuts work in any app.”、“Off. These shortcuts won’t respond…”；通用页 “Window Recording — Available”、“System linux · X11”；伴侣页 “1 animation · 14 KB”、规则编辑字数、快速菜单 “n → m characters”。
4. 空状态：截图库、Prompt 页只留标题 + 带快捷键的主按钮。
5. 删完看不懂的页面先记录，留给第二步改布局。

## 第二步：改布局、合并设置
1. 截图一律进历史，「截图后」只留「复制 / 打开标注」；`settings.rs` 加迁移（老配置保持原行为）并补测试。
2. 伴侣大小只留一个滑杆，删 Auto 和说明；动作表单列；“On Desktop” 改为状态按钮。
3. 设置页隐藏截图/录屏按钮；录屏声音只留在录屏菜单。
4. 命名统一为「截图 / 录屏 / 长截图」，快速菜单补长截图入口。
5. Prompt 库、宠物库改用主窗口组件，删各自 CSS；卡片只留预览、名字、安装。

## 第三步：纯重构（外观不变）
1. `PreferencesPage.tsx` 拆为截图 / 通用 / 伴侣页；`ShortcutsPage.tsx` 拆出存储、录制面板。
2. 合并两份窗口选择器；合并 `usePetAutonomy` 与 `usePetBehaviorAutonomy`。
3. 重写 README；新增 AGENTS.md（目标、目录、命令、验证）；加 `.nvmrc`（Node 22）；加 `npm run check`。
4. CI：ubuntu-22.04 改为夜间/发版运行；加 Rust 与 apt 缓存。

---

# 审计与计划详情

# Snapshot 简化计划（基于 main 670c41a）

审计时间：2026-11-11 19:20–19:30（UTC+8）。环境：box Linux 桌面（X11，1920×1200），670c41a release 构建，一次性数据目录 `simplify/home/`。
本文件只是计划：没有提交，也没有改 Mac 仓库。截图都在同一目录（编号见文末）。

目标一句话：**截图 → 标注/复制 → 找得回；录屏；Prompt 增强；桌面伴侣。** 不服务这四件事的文字、设置和代码都删掉。

判断标准（每一项都要同时满足）：
- **UX**：屏幕上要读的字更少，同一件事只有一个入口。
- **DX**：文件更少、更小，文件名和内容对得上，一条命令就能检查全部。
- **AX**：智能体能靠 AGENTS.md 定位代码，靠确定性的测试和截图验证改动。
- 不弄坏任何东西：保留每个已有功能和旧 settings.json 的兼容。每一步都单独提 PR，可以单独回滚。

---

## 0. 现状盘点

### 0.1 UX：文字和控件清单

处理方式：**砍** = 直接删；**并** = 和别处合成一个；**布局** = 改布局，让这句话不再需要。

| # | 位置（file:line） | 现在的文字/控件 | 处理 |
|---|---|---|---|
| 1 | HistoryPage.tsx:255 | “Screenshots you take appear here, grouped by day.” | 布局：空状态只留标题和一个「截图」主按钮（01） |
| 2 | HistoryPage.tsx:256 | “Press {keys} to capture the frontmost window.” | 布局：把快捷键直接写在主按钮上（`Capture  Ctrl⇧A`） |
| 3 | HistoryPage.tsx:262 / :271 | “‘Save screenshots to History’ is off…” / “Turned on. New screenshots will be saved here.” | 砍：见设置合并 S1，「不存历史」这个状态没有了，这两句也就不需要了 |
| 4 | HistoryPage.tsx:302 | “{picked} of {count} selected”、“Select Group” | 并：工具栏只显示「已选 N」；分组标题本身可以点来全选 |
| 5 | PromptsPage.tsx:73 | “When you enhance a prompt from the Quick Menu, the original and the result appear here.” | 布局：空状态只留标题和「增强 Prompt」快捷键（02） |
| 6 | PreferencesPage.tsx:191 / :213 / :215 / :230 | 「Size」和「Base size (100%) · Auto」两个滑杆，外加 “Pets are sized automatically. Changes here apply only to ‘{name}’.” | 并：只留一个「大小」滑杆（自动基准在内部算），提示砍掉（08、25） |
| 7 | PreferencesPage.tsx:40-56 + 存历史开关 | 「After capture: Copy / Open in Markup / Save to History」和「Save screenshots to History」开关含义重叠 | 并：见 S1 |
| 8 | PreferencesPage.tsx:275/276/295 | “Window Recording — Available”、“Scrolling Screenshot — Available”、“System linux · X11” | 砍：这是诊断信息。不支持的功能直接在菜单里置灰（05） |
| 9 | ShortcutsPage.tsx:259 / :260 | “Off. These shortcuts won’t respond…Your key combinations are kept.” / “These shortcuts work in any app.” | 砍：开关本身已经说明了状态；关闭后快捷键行变灰就够了（04） |
| 10 | ShortcutsPage.tsx:213 | 每一行都有 “Click to set” | 砍：未设置时显示「—」，悬停时显示描边 |
| 11 | ShortcutsPage.tsx:137 | “Shortcuts saved. They stay paused until you turn them back on.” | 砍：toast 只在保存失败时出现 |
| 12 | CaptureTools.tsx:233/240 与 ShortcutsPage.tsx:415/425 | 「录制系统声音 / 麦克风」在录屏菜单和设置页各出现一次 | 并：只留在录屏菜单（录之前选，选择照样持久化），设置页删掉（14、03） |
| 13 | CaptureTools.tsx:214/224 | 菜单标题 “Choose a Window to Capture / Record” | 砍：按钮本身已经说明了用途（13、14） |
| 14 | 所有页面的 Toolbar | 设置页右上角也有「Capture / Record」 | 布局：两个按钮挪到侧栏顶部，全局只出现一次；页面头部只放标题和本页操作（03、04、05） |
| 15 | PetPage.tsx:235/236 | “1 animation · 14 KB” | 砍（08） |
| 16 | PetPage.tsx:161 | 置灰的 “On Desktop” 文字，和侧栏的 ✓ 重复 | 并：改成一个状态按钮「在桌面上 ✓ / 放到桌面」，侧栏 ✓ 保留（08、25） |
| 17 | PetPage 动作表 | Animations 表格第二列是空的 | 布局：改成单列列表，播放按钮放在行尾（08） |
| 18 | PetCatalog.tsx:186 | “Pick a pet to install and start using it right away. Downloads keep going if you close this window.” 加上 “Pet Gallery 18” 计数 | 砍：卡片只显示「预览 + 名字 + Install」；Size / Version / License / tag 挪到点开后的详情里（27） |
| 19 | RulesPanel.tsx:317 / :305 / :161 | “Tell the model how to enhance your prompts”、“For example, Translate to English”、规则行和编辑框标题上的 “3,602 characters” | 砍：标题和 placeholder 只保留一个；字数只在接近上限时显示（22、05） |
| 20 | ModelSettingsDialog.tsx:139 | “Saved — leave blank to keep it” | 布局：已保存的 key 显示成 `••••••••  更换`，不再需要说明（06） |
| 21 | QuickMenuWindow.tsx:521 / :530 | “{source} → {result} characters”、“Enhancing with ‘{template}’ · {seconds}s” | 砍掉字数；进度只显示规则名和转圈（11） |
| 22 | QuickMenuWindow.tsx:599/600 | macOS 权限长段落 | 布局：一行「需要屏幕录制权限」加上「打开系统设置」按钮 |
| 23 | Lightbox.tsx:185 | “960 × 580 · 60 KB · PNG · Today 19:23” 加 “1 / 2” 计数 | 砍掉计数；元信息只在按 `i` 或悬停时显示（16） |
| 24 | AnnotateWindow.tsx:1031 | “Pixelate works with Rectangle, Oval, Pen, and Highlighter” | 布局：选中不支持马赛克的工具时，直接不显示马赛克色块（17b） |
| 25 | AnnotateWindow.tsx:752 / :789 | 底部状态文字 | 砍：用按钮的成功/失败态表达 |
| 26 | 11 个文件里的 31 个 `title=` | 例：侧栏伴侣行悬停时显示完整源文件路径（25） | 逐个审：只保留纯图标按钮的 tooltip，删掉路径和重复的说明 |
| 27 | 命名 | 快速菜单写 “Screenshot / Screen Recording”，快捷键页写 “Window Screenshot / Window Recording”；滚动长截图在快捷键页有，在快速菜单里没有；中文侧栏是 “Prompt 记录” | 并：全局统一成「截图 / 录屏 / 长截图」。快速菜单补上长截图（这个功能已经有，只是缺入口）（11、04、24） |
| 28 | PromptLibraryWindow（自带 355 行 CSS） | 棕色 “New Ctrl N” 按钮、“01” 编号、“0 items” 计数，是另一套视觉语言 | 布局：改用主窗口的组件和颜色，删掉编号和计数（21） |
| 29 | 录屏结束 | 只弹一个 toast，文件进了 Downloads，应用里看不到 | 布局：录屏结果也进「截图记录」（显示视频缩略图和时长），不再需要 toast（19）。这是给现有产物补一个入口，不是新功能 |
| 30 | 缩略图说明 | 每张都写「应用名 + 时间」，全屏截图叫 “screen” | 砍掉时间（日期分组已经有了）；名字只在悬停或搜索时显示（15） |

已经够干净、不用动：Launchpad（12）、标注工具栏（17）、桌面伴侣本体（10）。

### 0.2 设置：用好默认值能删掉的项

- **S1**「截图后」和「保存截图到历史」合并：截图**一律**进历史（像系统截图那样）。只剩一个选项「截图后：复制 / 打开标注」。旧值迁移：`afterCapture=history` 改成 `clipboard` 且不写剪贴板（另存一个内部标志，行为不变）；`autoSaveLocal=false` 的老用户保留原行为，只是 UI 上不再提供这个开关。
- **S2** 伴侣的 Size 和 Base size 合成一个滑杆（见 #6）。
- **S3** 录屏声音只留在录屏菜单里（见 #12）。
- **S4** General 页删掉 System、Window Recording、Scrolling Screenshot 三个诊断行（见 #8）。
- **S5** Prompt 相关设置（模型、规则、“Copy result automatically”）从 General 挪到 Prompts 页的「⋯ / 设置」里。General 只剩语言和开机启动。
- **S6** “Copy result automatically” 现在存在 localStorage（lib/prefs.ts），要迁到 settings.json，和其他设置保持一致（见 A6）。
- 候选，先不动：剪贴板定时清空（30s/60s/5min/Never）、快门声音（Crisp/Soft/None/Custom）。它们有实际用途，只做文字精简。

### 0.3 架构：数字

- 规模：TS/TSX 非测试代码 14,554 行，测试 8,849 行（42 个测试文件）；Rust 18,724 行；CSS 1,955 行（styles.css 593、main-window.css 511、app.css 410、PromptLibraryWindow.css 355）。
- 大文件：
  - 前端：PetWindow.tsx 1300、AnnotateWindow 1118、LaunchpadWindow 855、QuickMenuWindow 647、PromptLibraryWindow 508、ShortcutsPage 457、preview.ts 410、PreferencesPage 402。
  - Rust：pet.rs 1339、os/windows/recorder.rs 1288、pet_key.rs 1113、settings.rs 1075、lib.rs 952、os/windows/apps.rs 908。
- 伴侣相关：Rust 6 个 pet_*.rs 共 4,291 行，前端 4,022 行。前端有**两套自主行为引擎**：usePetAutonomy（通用走动）和 usePetBehaviorAutonomy（素材包自带 behavior），都在 PetWindow 里同时挂着。
- 文件名和内容对不上：
  - PreferencesPage.tsx 里其实是 CapturePage、GeneralPage 和 PetPanel；
  - ShortcutsPage.tsx 里有存储设置行和 RecordingPanel；
  - RulesPanel 放在 pages/ 下面。
- 重复逻辑：CaptureTools.tsx 和 QuickMenuWindow.tsx 各自实现了一遍窗口选择器。文案也重复（“正在读取窗口…”、“窗口已关闭”、空列表、权限提示）。
- 死代码（knip）：
  - 未使用的文件：src/lib/activity.ts（旧的「猫播报」）。
  - 12 个未使用导出：launchpadPaging 的 SPRING_*、motion.flyImage、petSync.askPetAnimation/onPetAnimation、Shell.isMacWindow/sortedPets、PreferencesPage 的面板导出等。另有 10 个未使用的导出类型。
  - format.ts 的 formatWhen 只有测试在用。
  - main.tsx 里的 `applyMotion("full")` 是常量调用，主题和动效功能早就删了。
- i18n：670 个键（其中 161 个是错误文案），`t()` 调用点 451 处。约 80 个非错误键疑似没人用，比如 快捷操作、历史记录、偏好设置、主题库、布局主题、浅色、深色、动效、今日流水、时间线、敲键盘笔记本，以及好几个「已复制标注图…」变体。check-i18n.mjs 检查不出多余的键。
- Tauri 命令：64 个。`show_main_window` 只在托盘和菜单里通过 Rust 调用，前端从没 invoke 过，可以不再注册为命令。
- 依赖：npm 有 5 个运行时依赖和 10 个开发依赖，已经很精简。Cargo 有 28 个依赖，其中 `core-foundation` 在代码里查不到任何 `core_foundation::` 用法，疑似多余（要在 macOS 构建上确认）。

### 0.4 DX / AX 缺口

- **README 过期**，智能体会被它误导：
  - “four layout styles, light and dark themes”，主题功能已删；
  - “Unified history”，截图和 Prompt 现在分成了两页；
  - 引用的 “Preferences”、“Shortcuts → Clipboard and saving”、“Themes page” 都已不存在。
- 没有 AGENTS.md，也没有架构地图。docs/ 只有两篇（其中 pending-device-verification.md 有 152 行）。
- 没有一条命令能把前端和 Rust 检查一起跑完（npm test、build、check-i18n、cargo fmt/clippy/test 都得分开跑）。
- 没有无头 UI 验证。这次的截图全靠手写的 xdotool 坐标脚本，坐标还要 ×1.875 换算，很脆弱。
- CI 墙钟 382 秒，瓶颈是 rust ubuntu-22.04（379 秒）和 ubuntu-24.04（346 秒），主要耗在 apt 装依赖和编译。security 200 秒，frontend 46 秒。
- 本地 Node 24/26 和 CI 的 Node 22 不一致，之前已经因此出过 Blob/Response 测试的问题。

---

## 1. 第一阶段：只删不改（低风险、立刻见效）

| 项 | 改动 | 为什么（UX / DX / AX） | 风险 | 怎么验证 |
|---|---|---|---|---|
| 1.1 | 删死代码：activity.ts、formatWhen（连同它的测试）、12 个未使用导出、`applyMotion("full")` 和 motion 残留、`show_main_window` 的命令注册 | DX/AX：knip 清零，智能体不会再被死代码误导 | 低：knip 和 TS 编译能兜底 | `npx knip` 0 报告；`npm test`、`npm run build`；`cargo clippy -D warnings` |
| 1.2 | 删约 80 个未使用的 i18n 键；check-i18n.mjs 增加「未使用键」检查 | AX：词典就是真实 UI 的清单 | 低：动态拼接的键要白名单 | `node scripts/check-i18n.mjs`；中英文两种 UI 的截图对比 |
| 1.3 | 砍掉提示和次要标签：表中 #3 #8 #9 #10 #11 #13 #15 #19 #21 #23 #25 #26，只删文字不动布局 | UX：每页少 1–3 行字 | 低：只删文案，相关测试断言要同步更新 | 组件测试更新；Linux 截图前后对比（01–27） |
| 1.4 | 统一命名：「截图 / 录屏 / 长截图」，修正 “Prompt 记录” | UX：一个概念一个名字。AX：grep 一个词就能找到全部入口 | 低 | check-i18n；中英文截图 |
| 1.5 | 重写 README 的功能段（只写真实存在的东西）；新增 AGENTS.md（目标、目录地图、命令、约束、验证步骤） | AX：智能体的第一手上下文是对的 | 无 | 人工审阅；README 里提到的每个页面名都要在 i18n 里查得到（加一个脚本检查） |
| 1.6 | `npm run check` 一条命令跑完：tsc、vitest、build、check-i18n、knip、cargo fmt --check、clippy、cargo test。加 `.nvmrc`（22），和 CI 保持一致 | DX/AX：一条命令给出对错 | 无 | CI 里也改成调用同一条命令 |

## 2. 第二阶段：改布局、合并设置（中风险，每项单独 PR）

| 项 | 改动 | 为什么 | 风险 | 怎么验证 |
|---|---|---|---|---|
| 2.1 | 截图和录屏按钮挪到侧栏顶部，各页面头部只放标题和本页操作（#14） | UX：主操作位置固定，设置页更干净。DX：Toolbar 少一个 `capture` 属性 | 中：键盘焦点和快捷键提示要跟着走 | Shell 和 Toolbar 组件测试；Linux 截图 03/04/05 |
| 2.2 | 空状态改成「标题 + 一个主按钮（带快捷键）」（#1 #2 #5） | UX：不用读说明也知道下一步做什么 | 低 | HistoryPage/PromptsPage 测试；截图 01/02 |
| 2.3 | S1：截图一律进历史，「截图后」只剩「复制 / 打开标注」；settings.rs 做一次迁移，老配置保持原行为 | UX：少一个开关和一套提示（#3 #7）。DX：少一条分支 | 中：涉及老用户数据 | settings.rs 加迁移单元测试（三种旧组合）；smoke：截图后检查剪贴板和历史 |
| 2.4 | S2：伴侣只留一个大小滑杆；动作表改成单列；「在桌面上」改成状态按钮（#6 #15–17） | UX：伴侣页从 7 个控件减到 4 个 | 中：实际尺寸计算不能变 | petSize/petAutoScale 测试：同一素材在新旧版本算出的像素尺寸一致；截图 08 |
| 2.5 | S3/S4/S5：录屏声音只留在菜单里；删掉诊断行；Prompt 设置挪到 Prompts 页 | UX：General 页只剩 2 项。DX：设置页文件变小 | 中：用户可能找不到原来的入口 | 设置字段一个不删（只是挪位置）；Rust 端 settings 测试不变；截图 03/05/02 |
| 2.6 | 快速菜单补上长截图入口，进度提示精简，权限提示改成一行加按钮（#21 #22 #27） | UX：和快捷键页一一对应 | 低：功能已经有，只是加入口 | QuickMenu 测试；Linux 上跑一次长截图 |
| 2.7 | 录屏结果进「截图记录」（视频缩略图和时长），去掉完成 toast（#29） | UX：录完能在应用里找到 | 中：要索引 Downloads 里的视频；只登记本应用生成的文件 | Rust 历史索引测试；smoke 录屏后在库里看到这一条（19） |
| 2.8 | Prompt Library 和 Pet Gallery 窗口改用主窗口的组件和样式，删掉编号、计数、标语，卡片只显示必要信息（#18 #28） | UX：三套视觉语言合成一套。DX：可以删掉 PromptLibraryWindow.css 的 355 行 | 中：视觉改动大 | 截图 21/27 前后对比；键盘操作（Ctrl N、Esc）测试 |
| 2.9 | Lightbox 去掉计数，元信息按需显示；缩略图说明去掉时间（#23 #30） | UX | 低 | Lightbox 测试；截图 15/16 |
| 2.10 | ModelSettings 的 key 字段改成「•••• 更换」（#20） | UX | 低：不能把已保存的 key 清空 | 对话框测试：留空保存时 key 保持不变 |

## 3. 第三阶段：理顺结构，让智能体能自己验证（中风险，纯重构，行为不变）

| 项 | 改动 | 为什么 | 风险 | 怎么验证 |
|---|---|---|---|---|
| 3.1 | 一页一个文件：pages/{Screenshots,Prompts,Capture,Shortcuts,General,Pet}Page.tsx，RulesPanel 移到 components/ | DX/AX：文件名就是导航 | 低：只是搬代码 | tsc、vitest；diff 里没有逻辑变化 |
| 3.2 | 抽出共用的窗口选择器（useWindowPicker 加一个组件），CaptureTools 和 QuickMenu 都用它 | DX：同一份逻辑和文案只写一次 | 中 | 共用 hook 的单元测试；两个入口各跑一次 smoke |
| 3.3 | 合并两套伴侣自主行为引擎成一个调度器（behavior 素材是数据，通用走动是默认 behavior）；把 PetWindow 1300 行里的纯逻辑拆到 lib/，目标 <500 行 | DX/AX：伴侣只有一个状态机 | 中高：动画时序容易出问题 | 现有 petBehavior/petWalk 测试全部通过；加确定性调度测试（假时钟加种子随机数）；Linux 上实测走动、拖拽、重力 |
| 3.4 | AnnotateWindow、LaunchpadWindow 同样拆出纯逻辑（工具状态和分页），只留视图 | DX | 中 | 新增纯函数测试；截图 12/17 |
| 3.5 | Rust：lib.rs 的命令注册和托盘挪进 commands.rs / tray.rs；settings.rs 的迁移代码单独放进 settings/migrate.rs；核实并删掉 core-foundation | DX/AX | 低到中 | 四平台 CI；`cargo tree -i core-foundation`；macOS 构建 |
| 3.6 | 正式的无头 UI 验证：Linux 下用 Xvfb、tauri-driver 和 WebKitWebDriver 跑端到端测试，固定种子和一次性数据目录，用元素选择器代替坐标；`npm run e2e:linux` 自动输出每页截图 | AX：智能体能自己确认「没弄坏」，不再靠手写坐标 | 中：CI 时间会增加 | 先作为可选 CI job；截图和基线逐像素/感知哈希比对 |
| 3.7 | CI 提速：ubuntu-22.04 只在发布和夜间构建时跑；Rust 缓存（Swatinem/rust-cache）；apt 依赖缓存 | DX：PR 反馈从约 6.4 分钟降到约 3 分钟（估计） | 低：22.04 的回归发现会推迟到夜间 | 对比前后 CI 时长；夜间构建失败时自动开 issue（要用户同意后再开） |

---

## 4. 每个 PR 都要过的统一验证

1. `npm run check`（第 1.6 项建成后），里面包含 tsc、vitest、build、check-i18n、knip、cargo fmt/clippy/test。
2. 在 Node 22 下跑（和 CI 一致）。
3. Linux 实机截图：用一次性数据目录，和本目录 01–27 做前后对比（第 3.6 项建成后自动化）。
4. `contract-snapshot.sh`：命令和设置的契约不变（重构类 PR 必须零 diff）。
5. 四平台 CI 全绿。macOS 和 Windows 上验证不了的，登记到 docs/pending-device-verification.md。

## 5. 截图索引（670c41a，改动前）

- 主窗口：01 空截图库、02 空 Prompt 页、03 截图与录制设置、04 快捷键、05 通用、06 模型对话框、07 前台应用图标伴侣、08 自定义伴侣页、15 有内容的截图库、16 Lightbox、18b 录制中的标题栏、19 录完、20 选择模式、22 规则编辑、23 截图库、24 中文截图与录制设置、25 中文伴侣页。
- 全屏：10 桌面伴侣、11 快速菜单、12 Launchpad、13 截图菜单、14 录屏菜单、17/17b 标注、18 录制中、21 Prompt Library、26 伴侣「⋯」菜单、27 Pet Gallery。
