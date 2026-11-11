# Snapshot 简化执行记录

基线：`670c41a`。日期：2026-11-11（UTC+8）。本计划已按代码评审修订。
原始 181 行审计完整保存在 `backup/simplify-20261111:docs/SIMPLIFY.md`，不再与执行清单并列作为指令。

## 目标与边界

主窗口优先完成「截图 → 复制或标注 → 找回」。保留录屏、Prompt 增强、Prompt 库和桌面伴侣，按使用场景组织入口。

- UX：减少判断和无用阅读；入口、当前状态、结果和恢复办法仍然清楚。
- DX：职责、状态来源和依赖更清楚；减少重复实现和修改范围，不以文件数或行数作为验收指标。
- AX：靠目录说明定位代码，靠同一套命令和确定性行为检查验证结果。
- 以一个完整任务为单位同时改善三者；文字与替代布局、状态反馈一起交付。
- 保留现有配置、IPC、窗口和数据兼容。不同场景可有多个入口，共用实现与状态。

## 回退机制

- `main` 保留在原始基线；所有工作在 `codex/simplify-*` 分支。
- `codex/simplify-00-baseline` / `backup/simplify-20261111`：代码和原始计划快照（`4efdd65`）。
- 每批完成检查后独立提交；下一批分支建立在上一批已验证的提交上。
- 撤销一批：`git revert <该批提交>`。检查整轮基线：`git switch -c codex/simplify-recovery backup/simplify-20261111`（先提交或保管当前改动）。
- 不使用 `reset --hard`、`clean` 或覆盖用户数据。回退代码不需要迁移 settings.json。
- 图片与契约证据放在本地忽略目录 `.tmp-simplify/`；提交中的验证记录注明条件和限制。

## 0. 改动前基线

- [x] Node 22：使用临时 npm 工具缓存，不更换系统 Node 26。
- [x] `npm test`：6 个脚本测试、42 个前端测试文件 / 546 个测试通过。
- [x] `npm run build`：通过；已有大于 500 kB 的 chunk 提示。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`：137 通过，1 个需要外部 Pets 仓库的测试按原设计忽略。
- [x] 契约快照：`.tmp-simplify/contract-before.txt`。
- [x] 浏览器预览截图：960×580、中文、内存 mock 后端，主窗口六个页面保存在 `.tmp-simplify/before/`。
- [x] Knip 基线：1 个未使用文件、27 个未使用导出、2 个导出类型；另核查仅测试使用的 formatWhen。

## 1. 工程与验证基础（codex/simplify-01-foundation）

- [x] `.nvmrc` 固定 Node 22；提供 `check`、`check:frontend`、`check:rust` 和 `check:i18n`。
- [x] CI 复用本地检查入口，保留 macOS、Windows、Ubuntu 22.04、24.04 四个 runner 和现有 Rust 缓存。
- [x] 添加简短 AGENTS.md、现有视觉规则 DESIGN.md，修正中英文 README。
- [x] `npm run check` 通过（546 个前端测试、137 个 Rust 测试）；Knip 命令先报告现状，第 2 批清理后纳入默认检查。

## 2. 确认无用的代码与翻译（codex/simplify-02-cleanup）

- [x] 删除未使用前端 activity.ts、formatWhen 和确认无调用的函数；测试仍需要的 API 保留。
- [x] 内部使用的常量、组件和类型只取消导出，不删实现。
- [x] 核查前后端调用，只移除 show_main_window 的 IPC 注册和 command 宏，保留托盘/菜单直接调用。
- [x] i18n 增加未引用键检查，覆盖元数据中的间接引用、模板字符串和 Rust 文案；错误词典不按前端调用裁剪。
- [x] Knip 零报告；翻译扫描自测、前端测试、构建、Rust 检查通过。

验证：`npm run check` 全部通过（10 个脚本测试、546 个前端测试、137 个 Rust 测试）。删除 88 个无引用翻译条目，保留 4 个动态拼接的标注结果翻译。契约差异仅为已确认未调用的 `show_main_window` IPC 注册；托盘和菜单函数保留，设置字段、事件名、窗口与存储键不变。

## 3. 按完整流程精简界面（codex/simplify-03-interface）

- [x] 主窗口截图/录屏入口固定在 shell；设置页头部只保留本页操作。
- [x] 空截图库与 Prompt 历史保留标题和实际可执行的主按钮；快捷键只在已绑定且启用时显示。
- [x] 快捷键保持按钮边界和键盘焦点，删除重复说明和逐行录制提示；保存失败和暂停状态保留明确反馈。
- [x] Prompt 模型与规则移到 Prompt 页的设置入口；通用页保留真正全局的设置，移除常驻诊断行。
- [x] 录屏声音只在录屏菜单设置并持久化；保留录屏完成反馈与输出目录入口。
- [x] 统一「截图 / 录屏 / 长截图」命名，快速菜单补长截图入口，保留权限恢复和不支持原因。
- [x] 伴侣动作单列、清楚显示在桌面状态，移除动画数量/体积；本轮保持两种缩放的作用域和行为。
- [x] 规则与快速菜单去掉装饰性字数；保留持久字段标签、等待状态和错误原因。
- [x] 已存 Key 用遮罩和显式更换操作展示，留空保存仍保留原 Key。
- [x] Prompt 库、宠物库复用视觉组件；元信息进入可访问的详情，安装/下载状态和错误保留。
- [x] 中英文、960×580 与最小 820×520、键盘操作、空状态、已有内容和失败状态检查。
- [x] 全量检查、截图比较、契约审阅后提交。

验证：`npm run check` 全量通过；553 个前端测试、10 个脚本测试、137 个 Rust 测试。契约快照与第 2 批完全相同。浏览器预览检查了主窗口空态、Prompt 设置、录屏声音菜单、快捷键 Esc 取消、保存 Key 的遮罩和焦点恢复；820×520 下检查了中英文和两种窗口按钮布局。独立库复用同一应用表面、搜索框和控件，删除原 PromptLibraryWindow.css 的 355 行。

## 4. 有证据的结构整理（codex/simplify-04-structure）

- [x] 拆分截图、通用和伴侣设置；存储设置移出 ShortcutsPage；RulesPanel 移到 components。
- [x] 共用快捷键查询放在 lib，避免页面之间相互依赖。
- [x] 提取两处窗口选择器的实际公共逻辑与视图，保留各入口的关闭、焦点、错误和时序行为。
- [x] 完整检查与契约快照零差异后提交。

验证：`npm run check` 全量通过（10 个脚本测试、553 个前端测试、137 个 Rust 测试、生产构建、Knip 零报告）；`node scripts/check-i18n.mjs` 报告 303 条直接文案与 382 条引用翻译无缺失、无未引用。契约快照与第 2、3 批完全相同，相对原始基线仍只差已确认未调用的 `show_main_window` IPC 注册。

原生 smoke 使用独立 identifier `com.appsnapshot.snapshot.simplify20261111` 与专用测试目录，debug 打包成功并真实启动：侧栏「资料库 / 设置 / 桌面伴侣」分组、截图与录制、通用、快捷键四个页面均正确渲染，`shortcutsPaused` 与快门「静音」等预置设置按预期生效，隔离目录未写入真实应用数据。验证后已退出该实例，`main` 与真实 settings.json 未被触碰。

结构拆分本身不改变行为：`PreferencesPage.tsx` 拆为 `pages/CapturePage.tsx`、`pages/GeneralPage.tsx`、`components/PetSettings.tsx` 与 `hooks/usePreferences.ts`；存储行独立为 `components/CaptureStorage.tsx`；`acceleratorOf` 移到 `lib/shortcuts.ts`，窗口候选标签移到 `lib/windowList.ts`；截图工具与快速菜单共用 `components/WindowIdentity.tsx`，各入口保留自己的关闭、焦点、错误与样式变体。

## 5. 修复切页时侧栏闪白（codex/simplify-05-sidebar-flash）

- [x] 复现并量化：隔离 identifier 的 debug 包里把换页动画临时放慢到 20 秒，侧栏中途帧采样为 `#f8f8f8`，稳定态为 `#f0f0ee`。
- [x] 定位：旧根快照是整屏位图，macOS 透明窗口下的毛玻璃材质不在其中，覆盖到实时页面上就把侧栏拍成偏白的平板。
- [x] 修复：`src/styles/app.css` 只在换页时隐藏 `::view-transition-old(root)`；内容区仍由 `page` 组交叉淡入，导航墨线仍由 `nav-mark` 组滑动。
- [x] 验证：同样慢速采样，去「通用」和回「截图记录」两个方向的中途帧都回到 `#f0f0ee`，与稳定态一致；中途截图确认内容区照常淡入。

验证：`npm run check` 全绿（10 个脚本测试、553 个前端测试、137 个 Rust 测试、构建、Knip 零报告）；契约快照与第 4 批完全相同。修复前证据为 `.tmp-simplify/u1-idle-active.png`、`.tmp-simplify/u2-mid.png`，修复后为 `x1/x2`（正向）与 `y1/y2`（反向）。

## 暂缓事项与原因

- **截图策略迁移**：真实枚举是 clipboard / annotate / saveas。仅保存必须进历史，关闭历史的旧用户也要保持原行为。本轮保留选项与开关，不新增隐藏标志。未来需先列出 3×2 配置行为表，并验证保存失败及迁移幂等。
- **合并伴侣缩放**：当前全局倍率与单素材基准含义不同；先明确单滑杆作用域与旧值转换。
- **合并伴侣自主行为引擎**：两套 hook 运行条件互斥；须证明共享调度能降低复杂度并保护动画时序，再单独评审。
- **录屏进入历史**：涉及媒体类型、索引、预览、缩略图和文件失效处理，单独作为产品任务。
- **Lightbox 位置、时间与元信息**：不为减少标签而删除有用信息；按需展示需要明确、可键盘访问的入口。
- **大文件行数目标、Rust 模块大搬迁**：只在职责问题已证实时处理；不为小于 500 行而拆分。
- **core-foundation**：跨平台依赖调整另做构建审查。
- **完整无头 E2E**：先保留可复现预览证据和原生 smoke；以后独立建设驱动、稳定时钟与基线体系。
- **减少 Ubuntu 22.04 PR 覆盖、自动开 issue**：不纳入本次简化。

## 验证规则

每批运行 `npm run check`，包含前端测试、i18n、生产构建以及 Rust fmt / Clippy（all-targets）/ test。清理完成后纳入 Knip。
编辑时先运行相关检查，验收时跑全量；不对每条文字修改重复搭建整套环境。

浏览器预览用于布局、语言和键盘检查，不代表真实权限、截图、录屏、剪贴板或透明窗口行为已通过。
原生 smoke 使用独立 identifier 和专用测试目录；未完成的跨设备验证记录在 `docs/pending-device-verification.md`。
本地 macOS 通过不能替代 Windows 和 Linux CI；本次不自动推送或发布。
