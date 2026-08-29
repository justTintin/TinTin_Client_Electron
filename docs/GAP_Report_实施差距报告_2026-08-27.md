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
| **P4** | **定时任务缺口补齐** ✅ 已完成（2026-08-28） | 审计发现的 4 缺口全部闭环，见 §4.1 |
| 待定 | PRD 4 高频页（脚本/分镜/检索/成片任务） | 会话智能体优先承载；是否原生补齐按需评估（缺口清单见 §3.2） |
| 🚫 取消 | ~~P2 桥接基建 + 7 页 webview~~ | bridge.exe 依赖 Python，作废 |
| 🚫 取消 | ~~原侧边栏其余页面移植~~ | 会话智能体承载，不移植 |

### 4.1 P4 定时任务缺口补齐 —— ✅ 已完成（2026-08-28）

| # | 缺口 | 实现载体 | 对照基准 |
|---|---|---|---|
| 1 | hotspot 到点断链（主进程推送无渲染层订阅） | [App.vue](../desktop/renderer/src/App.vue) 订阅 `onScheduledHotspot` → bump `appStore.pendingHotspotNav`（单一信号源）+ 切浏览器 Tab；[Browser.vue](../desktop/renderer/src/views/Browser.vue) watch → `navigateToHotspot()`（[useBrowserNav.ts](../desktop/renderer/src/composables/useBrowserNav.ts) 导航热榜首站 douyin/hot） | 原版 launch_hotspot_capture |
| 2 | hotspot 采集链路（立即采集按钮为占位） | [hotspot-capture.js](../desktop/main/hotspot-capture.js)：隐藏 BrowserView（bounds 移出可视区）+ CDP debugger 拦截四平台热榜 API + DOM 兜底 + 清单追加（userData/hotspots/hotspots_sync.json）；触发编排收敛在 [local-scheduler.js](../desktop/main/local-scheduler.js) `setupTriggerRelay`（hotspot=采集→切 Tab；agent=plan 优先提交）；手动入口 = 抽屉「立即采集今日热点」按钮（进度推送 `scheduled:capture-progress`） | preload-webview.js L1188+ 四段解析逐行对照 / app.js HOTSPOT_PAGES / main.js append-hotspot-manifest |
| 3 | agent 任务拆解链路 | [agent-plan.js](../desktop/main/agent-plan.js)（prompt/解析/校验纯函数 + splitPlan）→ IPC `agent:splitPlan` → useScheduledTasks `splitPlan()` 拆解预览 → 注册时存 plan → 到点 `buildAgentSubmitBody` plan 优先提交 | agent_router.build_plan |
| 4 | 编排任务详情弹窗 + 能力 api 字段 | WbScheduledDrawer：「详情」→ `server.tasksUnifiedItem`（/tasks/unified/{id} 子步骤树）弹窗；能力卡新增 API 路径展示 | 原版任务详情语义 |

门禁：node --check ×6 全过 / 单测 22/22（新增 hotspot-capture 9 项）/ typecheck / vite build / 单文件 ≤800 行（main.js 788，触发编排已移入 local-scheduler.js）。

> 交付口径（不变）：对照原客户端 `studio/gui` 对应 .py 逐项行为核对 + IRON-04 单测 + 门禁（node --check / typecheck / 零残留）+ 打包产物更新验证 + IRON-09 提交。

## 五、验证口径

- 每页实现均须通过：门禁（node --check + typecheck + 零残留）→ dev 环境手动验收（对照原客户端 `studio/gui` 对应 .py 行为逐项核对）→ 打包产物更新验证 → IRON-09 提交
- 四页为「核心链路」，须按 IRON-04 同步补单元测试（先红后绿）

## 六、服务端配置业务对齐（2026-08-28 用户裁决）

### 6.1 错误现状（裁决前）

此前移植时错误地把 LLM 做成了客户端凭证形态，偏离原客户端业务模型：

1. 设置页展示 Provider / API Key（服务端脱敏回显）/ Base URL 只读字段，并有独立「LLM 测试连接」（`llm:chat` 发 `ping` 消息探测）
2. IPC 链路存在 `llm:providers`（GET /llm/providers）专门用于凭证回显
3. 设置页分段「LLM 设置 / 服务接入」割裂；「服务接入」内同时存在「本地服务端」与「服务端地址」两个概念
4. `getServerUrl` 实际从未读取 electron-store `'server.url'`（`setConfigStore` 注入后成死代码），设置页保存服务端地址后并不生效——保存 → 联动链路断裂

### 6.2 原客户端流程（证据）

原客户端（`D:\Project\TinTin_AI_Agent_Main\studio\gui`）只有一个统一服务端地址，配置后联动各功能服务地址：

- `main_window_aiconfig.py` L26-L53：`_collect_all_config_from_ui` 统一收集 `compute_server_url`（L50-L52「统一服务端地址」）与各功能地址（Whisper/CLIP/OCR/VoxCPM）
- `main_window_aiconfig.py` L89-L115：`_on_server_url_changed` 服务端地址变更即时联动各 Tab（视觉/Whisper/CLIP/OCR 直接同步，VoxCPM 追加 `/voxcpm/tts` 后缀）
- `main_window_pages.py` L670-L739：「模型配置」页顶部「服务端地址（统一配置）」输入 + 「保存全部」；LLM 分组内 `llm_api_key_input` 已 `setVisible(False)` 隐藏（L724-L726 注释：API Key 已隐藏，保留属性避免保存/测试代码崩溃）——即原客户端就不在客户端展示 API Key
- 模型列表从服务端拉取

### 6.3 整改后流程（本次落地）

1. **唯一统一服务端地址**：electron-store `'server.url'` 单一键（经 IPC 持久化）；保存后主进程 `getServerUrl` 立即生效（`httpRequest` / `env:serverPing` 均经它）→ 自动 ping 总连通 + 从服务端拉取模型列表（GET /llm/models）
2. **删除 Provider/API Key/URL UI 与 IPC**：`llm:providers` 通道（handler / preload 方法 / 类型声明）全部移除；LLM 凭证由服务端持有，客户端只选模型
3. **取消独立「LLM 测试连接」，改为按功能分别测试**（端点全部核对自根目录 openapi-latest.json，无臆造）：

| 功能 | 端点 | 判定 |
|---|---|---|
| LLM · 模型列表 | GET /llm/models | 2xx 且 `models` 数组非空；顺带刷新下拉数据源 |
| OCR · 文字识别 | POST /material/ocr | 该域无健康端点：发最小空请求，服务端校验响应（4xx）= 端点可达 |
| 向量 · 图文检索 | GET /clip/health | 2xx |
| TTS · 语音合成 | GET /voxcpm/health | 2xx |
| ASR · 语音识别 | GET /whisper/health | 2xx |

   离线（ECONNREFUSED 等）由主进程按既有约定静默返回 null 判失败；每项支持单独测试 + 「全部测试」并行；总连通测试 = `env:serverPing`（GET /health，含延迟）
4. **不动的部分**：inference-router 本地推理/回退逻辑、CardA2Inference.vue（核查确认其无独立服务端地址输入，无 server.url 重复）

### 6.4 改动文件清单

| 文件 | 改动 |
|---|---|
| [desktop/main/server-proxy.js](../desktop/main/server-proxy.js) | 移除 `llm:providers` handler 与 `API_ENDPOINTS.llm.providers`；`getServerUrl` 打通 electron-store `'server.url'` 优先读取（修复 setConfigStore 注入死代码，`_configStore` 声明前移） |
| [desktop/preload/preload.js](../desktop/preload/preload.js) | 删 `llmProviders` 方法 |
| [desktop/types/global.d.ts](../desktop/types/global.d.ts) | 删 `llmProviders` 声明 |
| [desktop/renderer/src/composables/useSettingsGeneral.ts](../desktop/renderer/src/composables/useSettingsGeneral.ts) | 删 provider 脱敏展示与 `llm:providers` 调用、删独立 `testLlm`；新增 `perFunctionTest()` / `testFunction()` 与 `funcResults`；`fetchLlm` 拆出 `applyModels`（保存地址成功后自动拉取模型列表） |
| [desktop/renderer/src/components/settings/CardPlatform.vue](../desktop/renderer/src/components/settings/CardPlatform.vue) | 改造为「服务端」卡：单一地址输入 + 显式保存 + 总连通测试 + 按功能测试（行内结果点与文案）；「模型」分页仅模型下拉/联网搜索/保存 |
| [desktop/renderer/src/views/Settings.vue](../desktop/renderer/src/views/Settings.vue) | 容器接线同步（删 provider 系 props 与 `@test-llm`；接 `@test-func` / `@test-funcs-all`）；侧栏菜单 desc 更新为「服务端 · 模型」 |
| [desktop/tests/server-proxy-serverurl.test.mjs](../desktop/tests/server-proxy-serverurl.test.mjs) | 新增 3 项单测（先红后绿）：getServerUrl store 优先 / 无 store 回退 / providers 端点废弃 |

> 说明：`desktop/types/server-api.ts` 的 `LlmProvider` / `LlmProvidersResponse` 与 `api-contract.generated.ts` 的 `/llm/providers` 为**服务端 API 契约定义**（服务端 openapi 实有该端点），非客户端死引用，按契约层保留不删。

### 6.5 门禁记录（2026-08-28）

| # | 门禁 | 结果 |
|---|---|---|
| 1 | `node --check` main/server-proxy.js + preload/preload.js | ✅ 通过 |
| 2 | `npm run typecheck` | ✅ 通过 |
| 3 | `node --test tests/*.test.mjs`（原 22 + 新增 3） | ✅ 25/25 |
| 4 | 单文件行数 ≤800（最大 server-proxy.js 724） | ✅ 通过 |
| 5 | 零残留 Grep（llm:providers / llmProviders / apiKey / testingLlm / test-llm 等） | ✅ 仅测试文件 2 处「已废弃」断言说明（防回归注释，非死引用） |
| 6 | `npm run build:renderer` | ✅ 通过（2.12s） |

---
*报告基于 2026-08-27 代码库实际状态核实生成；浏览器章节证据：commit 9d2bd9c / daff559 / 840cf7f / edf2a93。*
