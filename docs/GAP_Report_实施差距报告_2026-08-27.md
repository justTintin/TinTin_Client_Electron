# 实施差距报告（Implementation Gap Report）

> 生成日期：2026-08-27 ｜ 基准文档：[PRD_Electron_v3_SchemeA.md](./PRD_Electron_v3_SchemeA.md) / [DESIGN_Electron_v3.md](./DESIGN_Electron_v3.md)（已同步至实现状态）
> 原客户端基准：`D:\Project\TinTin_AI_Agent_Main\studio\gui`（铁律：逻辑实现以原客户端代码为准）

## 〇、移植基本要求（2026-08-27 业务方定稿）

1. **移植范围 = 四部分**，全部以新语言（Electron + Vue + TS）原生实现，**不依赖 Python / PySide6**：
   - ① **工作台**：原工作台（会话智能体形态）+ 新增「定时任务」页
   - ② **浏览器**：原素材浏览器（apps/asset-browser）
   - ③ **媒体工具**：原媒体工具 + 新增卡片
   - ④ **系统配置**
2. **已移植且与原客户端不同的，以现在的实现为准**。
3. **原客户端左侧边栏其余页面不在移植之列**——其内容已由**会话智能体**（agent 工具调用）承载，不再走菜单页形式（PRD 4 高频页亦属此列，**降级为待定**，见 §3.2）。
4. **webview / bridge.exe 桥接过渡方案作废**（依赖 PySide6/Python，违反基本要求）。

## 一、模块总览（按四部分框架）

| 部分 | 范围 | 状态 | 说明 |
|---|---|---|---|
| ① 工作台 | 会话智能体（原工作台形态） | ✅ 已实现 | WbComposer / WbMessages / WbTaskDrawer / WbNotificationDrawer；以现状为准 |
| ① 工作台 | **定时任务管理（新增页）** | ❌ 待移植 | 对照 scheduled_tasks_mgmt_page.py 原生重写，进侧边栏 |
| ② 浏览器 | 原素材浏览器 | ✅ 已完成 | 含扩展下载/嗅探/合并下载/下载浮窗；以现状为准 |
| ② 浏览器 | **功能扩展分组 + 自动上架迁移** | ❌ 待移植 | 左栏新增「功能扩展」组（自动上架按钮在收藏记录上方，不与平台混排）；自动上架从系统设置迁入，载体改内置分区会话（见 §3.4） |
| ③ 媒体工具 | 原媒体工具 + 新增卡片 | ✅ 已完成 | ImageMatting / VideoTranscribe / VoiceClone / ReversePromptImage（新卡）/ CoverMaker（新卡）等；以现状为准 |
| ④ 系统配置 | 环境配置/推理设置 | ✅ 已完成 | useInferenceSettings 三模式推理路由；**「扩展插件」卡移除**（浏览器已集成，见 §3.4） |
| — | PRD 4 高频页（脚本/分镜/检索/成片任务） | ⏸ 降级待定 | 会话智能体优先承载，按需评估（见 §3.2） |
| — | 原侧边栏其余页面（方案脚本/一键成片/产品库/即梦AI/混剪/直播切片等） | 🚫 不移植 | 由会话智能体承载 |
| — | V3.1 多账号 profile | ⏳ 规划保留 | 按计划后置 |

## 二、已闭环：浏览器（以此实现为准）

- 多平台 BrowserView（8 平台 × 独立 `persist:tintin-<platform>` 分区），崩溃恢复 ≤3 次
- 媒体嗅探：onHeadersReceived + 详情页白名单（`skipped: NOT_DETAIL_PAGE` 不产生卡片）
- B站下载助手：预装扩展 + 手动注入（`import.meta.url` 合法化 / CSP 放行 / tintin-ext:// 协议）；链接提取双通道（executeJavaScript 2s 轮询为主 + console-message 冗余）
- 合并下载：durls 归并单条目（画质+体积标识）→ 双流下载 → ffmpeg 合并（`resources/bin/ffmpeg.exe` 随包内置）；进度内嵌嗅探卡片（视频 x% · 音频 y%）
- 下载管理：任务注册表单一真相源 + `downloads-history.json`（300 条上限）；默认 **Windows 下载文件夹**（`store: downloadDir` 可改）；⬇ 置顶浮窗（打开文件 / 打开位置 / 删除 / 清除已完成 / 📁 改路径）
- Cookie：分区隔离 + Netscape 导出（yt-dlp 可用）
- **方案变更（已废弃）**：~~⚡解析并导入素材库~~（素材库接口未就绪，commit 341e581）；~~底部全局下载进度池~~（改为卡片内嵌 + 浮窗）

## 三、差距明细：工作台（① 工作台移植）

### 3.1 形态与范围 —— ✅ 已裁决（2026-08-27，两轮）

- **形态**：回归 16 页功能工作台框架中的侧边栏导航形式；聊天形态（`WbComposer` / `WbMessages` / `WbTaskDrawer` / `WbNotificationDrawer`）保留资产，作为「智能助手」入口页。
- **范围**：工作台 = 会话智能体（现状）+ **定时任务管理**（新增原生页）；PRD 4 高频页降级待定（见 3.2）；原侧边栏其余页面不移植（会话智能体承载）。
- **侧边栏原则（渐进式挂载）**：骨架只挂真实存在的页面，每交付一个页面点亮一个菜单项，未交付的不显示或禁用（DESIGN §4.1 样式）。

### 3.2 PRD 4 高频页 —— ⏸ 降级为待定（2026-08-27 业务方裁决）

会话智能体优先承载其能力（脚本创作/分镜/素材检索/成片任务查询均可由 agent 工具调用完成）；是否以原生页形式补齐**按需评估**。若未来恢复移植，下列缺口清单仍然有效：

| # | 页面 | 缺口（若恢复移植时适用） | 接口就绪度 |
|---|---|---|---|
| 1 | 飞书脚本创作 | 无页面组件；`/script/list`、`/script/adjust-copywriting` 零调用；product{brand,model,category,name} 传递链路不存在 | 类型契约已生成 ✅ |
| 2 | 分镜脚本 | 无页面组件；相似度自动绑定 / 画幅下拉 / 保存联动刷新一键成片 均无 | 类型契约已生成 ✅ |
| 3 | ShotMaterialDialog | **整个对话框不存在**：素材库 Tab / MG动画跳转 Tab / 联网素材 Tab（`stock_search` 零调用） | 类型契约已生成 ✅ |
| 4 | 素材检索 | 无筛选面板与缩略图网格；`material_client.search` 零调用 | 类型契约已生成 ✅ |
| 5 | 成片任务 | 无 12 列表格（总分列优先级 `evaluation.total > quality_score.total > variants[0].score > task.*_score`）/ 全选+下载所选+打包所选 / 15s 自动轮询 / SSE | 类型契约 + SSE 通道 ✅ |

> 注：**定时任务管理**（scheduled_tasks_mgmt_page.py）不受此降级影响——业务方单独指定为新增移植项，排期 P2（见 §四）。

### 3.3 桥接方案 —— 🚫 作废（2026-08-27）

原 PRD 过渡方案（`<webview src="http://127.0.0.1:8766">` 内嵌 PySide6 打包的 bridge.exe，覆盖方案脚本/一键成片/产品库/即梦AI/音频素材/智能混剪/直播切片/成片任务队列等页）**整体作废**：

- 依赖 PySide6 / Python runtime，违反移植基本要求「不依赖 python」
- 其覆盖页面均已归入「不移植」清单，由会话智能体承载
- DESIGN §4.1「过渡期桥接页」分组同步标注作废；相关 IPC/预埋（如有）在 P1 骨架改造时一并确认无残留

### 3.4 浏览器功能扩展迁移 —— ❌ 待移植（2026-08-27 业务方裁决）

**背景**：原客户端与浏览器分离，「扩展插件」（下载插件 + 自动上架）必须配置在系统设置里对接外挂 Chrome；现浏览器已内置集成，该配置失去存在意义。

**裁决内容**：
1. 系统设置「扩展插件」卡**整体移除**（Settings.vue ext 菜单项 + CardExtensions.vue + useSettingsExtension.ts）
2. 「自动上架」迁移为**浏览器功能**：左栏新增独立「功能扩展」分组（不与平台混排），组内「自动上架」按钮位于「收藏记录」上方
3. 需求已确认进 [PRD §3.3](./PRD_Electron_v3_SchemeA.md) / [DESIGN §5.2b](./DESIGN_Electron_v3.md)

**基于「浏览器已集成 → 分离时代配置冗余」原则的连带修改清单**：

| # | 项 | 现状 | 处置 |
|---|---|---|---|
| 1 | Settings「扩展插件」卡（含下载插件 Tab 6 项配置：bridgePort/bridgeSaveDir/extScanServer/chromePort/chromePath/chromeDataDir） | [useSettingsExtension.ts](../desktop/renderer/src/composables/useSettingsExtension.ts) | 随卡移除 |
| 2 | `env:detectCdp` IPC（preload.js:393 + 主进程 handler） | 分离时代检测外挂 Chrome 通道 | ✅ 已随 P3 删除（env-ipc.js + preload + 零残留验证） |
| 3 | `ext.*` 配置键（electron-store） | bridge*/chrome* 6 键废弃；`shopKeyword`（上架关键词）仍需要 | ✅ 已随 P3 落地：`shopKeyword` 沿用 `ext.shopKeyword` 键无缝继承旧值；6 废弃键由 `config-migrate.js` 启动时幂等清理（单测覆盖） |
| 4 | `bridgeSaveDir`（采集目录 D:\TinTin\collected） | 已被下载路径体系（Windows Downloads + 浮窗 📁）替代 | 废弃，不迁移 |
| 5 | 「下载插件」职责（扩展安装/管理） | 已由浏览器 🧩 扩展管理覆盖（commit 历史已实现） | 无需迁移，文档标注即可 |
| 6 | 自动上架实现载体 | 原 auto_listing_tab.py：外挂 Chrome CDP(9222) + bridge(8123) | 改为操作内置浏览器 `persist:tintin-*` 分区已登录会话；**行为口径不变**（V2 PRD 十四章：抖店数据包校验/复用登录/填写/保存草稿/截图日志/断点续跑） |

## 四、实施排期（2026-08-27 最终版：按移植基本要求收敛）

| 优先级 | 事项 | 内容 / 理由 |
|---|---|---|
| **P1** | **工作台骨架改造** | 侧边栏导航骨架 + `/workbench/*` 子路由 + 顶栏任务/通知条；挂载「智能助手」（Wb* 平移）+「定时任务管理」（占位）；不移植页面不出现菜单项 |
| **P2** | **定时任务管理页（Vue 原生重写）** | 唯一确定的新增移植页：对照 scheduled_tasks_mgmt_page.py 逐项重写（定时任务创建/启停/调度管理），进侧边栏 |
| **P3** | **浏览器功能扩展分组 + 自动上架迁移** | 左栏「功能扩展」分组（自动上架按钮在收藏记录上方）+ Settings 移除「扩展插件」卡 + detectCdp/ext.* 废弃键清理（清单见 §3.4）；可与 P1/P2 并行 |
| 待定 | PRD 4 高频页（脚本/分镜/检索/成片任务） | 会话智能体优先承载；是否原生补齐按需评估（缺口清单见 §3.2） |
| 🚫 取消 | ~~P2 桥接基建 + 7 页 webview~~ | bridge.exe 依赖 Python，作废 |
| 🚫 取消 | ~~原侧边栏其余页面移植~~ | 会话智能体承载，不移植 |

> 交付口径（不变）：对照原客户端 `studio/gui` 对应 .py 逐项行为核对 + IRON-04 单测 + 门禁（node --check / typecheck / 零残留）+ 打包产物更新验证 + IRON-09 提交。

## 五、验证口径

- 每页实现均须通过：门禁（node --check + typecheck + 零残留）→ dev 环境手动验收（对照原客户端 `studio/gui` 对应 .py 行为逐项核对）→ 打包产物更新验证 → IRON-09 提交
- 四页为「核心链路」，须按 IRON-04 同步补单元测试（先红后绿）

---
*报告基于 2026-08-27 代码库实际状态核实生成；浏览器章节证据：commit 9d2bd9c / daff559 / 840cf7f / edf2a93。*
