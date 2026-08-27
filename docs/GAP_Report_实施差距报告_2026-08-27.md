# 实施差距报告（Implementation Gap Report）

> 生成日期：2026-08-27 ｜ 基准文档：[PRD_Electron_v3_SchemeA.md](./PRD_Electron_v3_SchemeA.md) / [DESIGN_Electron_v3.md](./DESIGN_Electron_v3.md)（已同步至实现状态）
> 原客户端基准：`D:\Project\TinTin_AI_Agent_Main\studio\gui`（铁律：逻辑实现以原客户端代码为准）

## 一、模块总览

| 模块 | PRD 章节 | 状态 | 说明 |
|---|---|---|---|
| Tab2 浏览器 | §3.3 | ✅ **已完成** | 8 平台分区、嗅探、B站扩展、合并下载、下载浮窗、扩展管理、Cookie 导出；文档已按实现重写 |
| Tab3 媒体工具 | §3.4 | ✅ 基本完成 | ImageMatting / SubtitleRemoval / VoiceClone / ReversePromptImage / CoverMaker / VideoTranscribe 等；已解耦（useServerTask / useFilePicker，净减 127 行） |
| 设置 Tab | — | ✅ 完成 | useInferenceSettings 拆分，三模式推理路由（server-only / hybrid-auto / force-local） |
| 服务端契约 | — | ✅ 完成 | openapi-typescript + openapi-fetch 对齐 /openapi.json；contract:gen / verify 门禁 |
| 工程纪律 | — | ✅ 完成 | 单文件 ≤800 行（Browser.vue 651、thickShell-ipc.js 556+6 模块） |
| **Tab1 工作台（4 高频页）** | §3.2 | ❌ **0/4 未实现** | 明细见第三节 |
| **过渡期桥接（12 页）** | §3.2 | ❌ **未实现** | 无 webview/iframe 内嵌、无 bridge.exe 集成 |
| V3.1 规划（多账号 profile） | §3.3 | ⏳ 规划保留 | 按计划后置 |

## 二、已闭环：浏览器（以此实现为准）

- 多平台 BrowserView（8 平台 × 独立 `persist:tintin-<platform>` 分区），崩溃恢复 ≤3 次
- 媒体嗅探：onHeadersReceived + 详情页白名单（`skipped: NOT_DETAIL_PAGE` 不产生卡片）
- B站下载助手：预装扩展 + 手动注入（`import.meta.url` 合法化 / CSP 放行 / tintin-ext:// 协议）；链接提取双通道（executeJavaScript 2s 轮询为主 + console-message 冗余）
- 合并下载：durls 归并单条目（画质+体积标识）→ 双流下载 → ffmpeg 合并（`resources/bin/ffmpeg.exe` 随包内置）；进度内嵌嗅探卡片（视频 x% · 音频 y%）
- 下载管理：任务注册表单一真相源 + `downloads-history.json`（300 条上限）；默认 **Windows 下载文件夹**（`store: downloadDir` 可改）；⬇ 置顶浮窗（打开文件 / 打开位置 / 删除 / 清除已完成 / 📁 改路径）
- Cookie：分区隔离 + Netscape 导出（yt-dlp 可用）
- **方案变更（已废弃）**：~~⚡解析并导入素材库~~（素材库接口未就绪，commit 341e581）；~~底部全局下载进度池~~（改为卡片内嵌 + 浮窗）

## 三、差距明细：工作台（Tab1）

### 3.1 现状与 PRD 的形态分歧 —— ✅ 已裁决（2026-08-27）

业务方裁决：**按 PRD 定义回归 16 页功能工作台形态**。

- 当前聊天形态（`WbComposer` / `WbMessages` / `WbTaskDrawer` / `WbNotificationDrawer`）**保留资产、降级收纳**为侧边栏导航中的「智能助手」页（待最终确认命名）。
- 工作台骨架改造为：侧边栏页面导航（16 项）+ `/workbench/*` 子路由 + 顶栏任务/通知条。

### 3.2 四个高频页（0/4）

| # | 页面 | 缺失关键点 | 接口就绪度 |
|---|---|---|---|
| 1 | 飞书脚本创作 | 无页面组件；`/script/list`、`/script/adjust-copywriting` 零调用；product{brand,model,category,name} 传递链路不存在 | 类型契约已生成 ✅ |
| 2 | 分镜脚本 | 无页面组件；相似度自动绑定 / 画幅下拉 / 保存联动刷新一键成片 均无 | 类型契约已生成 ✅ |
| 3 | ShotMaterialDialog | **整个对话框不存在**：素材库 Tab（角标多选/右键预览/品牌徽章）、MG动画跳转 Tab、联网素材 Tab（`stock_search` 零调用） | 类型契约已生成 ✅ |
| 4 | 素材检索 | 无筛选面板（文件类型/横纵比/分辨率/时长/品牌/型号/分类/Tag 云）与缩略图网格；`material_client.search` 零调用 | 类型契约已生成 ✅ |
| 5 | 成片任务 | 无 12 列表格（**总分列**优先级 `evaluation.total > quality_score.total > variants[0].score > task.*_score`）/ 全选+下载所选+打包所选 / 15s 自动轮询 / SSE 推送 | 类型契约 + SSE 通道 ✅ |
| 6 | **定时任务管理（新增移植项，2026-08-27 业务方指定）** | 对照 [scheduled_tasks_mgmt_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/scheduled_tasks_mgmt_page.py) 原生重写；**加入工作台侧边栏**；定时任务创建/启停/调度管理 | 类型契约 ✅ |

### 3.3 桥接页（过渡期 webview → bridge.exe）

PRD 过渡方案：`<webview src="http://127.0.0.1:8766/<page>">` 内嵌 PySide6 打包出的 bridge.exe 页面，右侧带「桥」标签（hover 提示「该模块正在升级中，V3.1 将全面重写」），未就绪菜单 opacity 0.5 + cursor not-allowed。

**需完成的桥接功能（基建）**：

| # | 工作项 | 说明 |
|---|---|---|
| 1 | bridge.exe 打包分发 | PySide6 studio 以页面服务模式打包为 bridge.exe，随 electron-builder extraResources 分发 |
| 2 | 生命周期管理（主进程） | app ready 拉起 / 退出 kill / 崩溃自动重启 / `127.0.0.1:8766` 动态端口防占用 |
| 3 | 健康探活 | `/health` 轮询 → 驱动侧边栏菜单启用态（未就绪禁用样式） |
| 4 | 通用 webview 容器页 | `WebViewPage.vue`：src 映射 / 加载态 / 失败重试 / 「桥」标签 + tooltip |
| 5 | 会话与 token 共享 | bridge 与 server 鉴权打通，避免桥接页二次登录 |
| 6 | webview 权限配置 | allowpopups、preload 注入 `window.tintin` 最小桥、CSP 对齐 |

**桥接页清单（7 页，映射原客户端）**：

| 桥接页 | 原客户端页面 |
|---|---|
| 方案脚本 | [product_script_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/product_script_page.py) |
| 一键成片 | [compile_video_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/compile_video_page.py) |
| 产品库 | [product_library_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/product_library_page.py) |
| 素材生成（即梦AI） | [dreamina_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/dreamina_page.py) |
| 音频素材 | [audio_material_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/audio_material_page.py) |
| 智能混剪 | [video_montage_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/video_montage_page.py) |
| 直播切片 | [live_clip_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/live_clip_page.py) |

> 原「成片任务队列」（scheduled_tasks_mgmt_page.py）已移出桥接池——业务方指定（2026-08-27）升级为**原生重写**的「定时任务管理」页，直接进侧边栏。

> 其余原客户端页面（marketing_detect / hook_score / video_lut / image_layered / video_ai_rename / agent_home 等）不在 16 页首期清单，作为 V3.1+ 备选池。已 Vue 实现的媒体工具页（ImageMatting / VideoTranscribe / VoiceClone / ReversePromptImage / CoverMaker 等）归 Tab3，不入桥接池。

## 四、实施排期（2026-08-27 第二次调整：+定时任务管理原生重写；侧边栏渐进式挂载）

> **侧边栏原则（渐进式挂载）**：P1 骨架只挂当前真实存在的页面（智能助手 + 定时任务管理占位），不一次凑满 16 项；每交付一个原生页/桥接页就点亮一个菜单项，其余保持隐藏或禁用态（DESIGN §4.1 未就绪样式）。

| 优先级 | 事项 | 内容 / 理由 |
|---|---|---|
| ~~P0~~ | ~~工作台形态裁决~~ | ✅ 已裁决：回归 16 页形态；聊天工作台收纳为「智能助手」页 |
| **P1** | **工作台骨架改造** | 侧边栏导航骨架 + `/workbench/*` 子路由 + 顶栏任务/通知条；挂载：智能助手（Wb* 平移）+ 定时任务管理（占位）；其余菜单项按交付逐个点亮 |
| **P2** | **桥接基建 + 7 页 webview 上线** | bridge.exe 打包/生命周期/探活 + WebViewPage.vue 通用容器 + token 共享；7 桥接页以「桥」形态进侧边栏 |
| **P3** | **定时任务管理页（Vue 原生重写）** | 业务方指定新增移植项（2026-08-27）；对照 scheduled_tasks_mgmt_page.py 逐项重写，进侧边栏 |
| **P4** | 成片任务页（Vue 重写） | 最独立、无跨页依赖、接口+SSE 就绪；完成后从占位切原生 |
| **P5** | 飞书脚本创作页 | 四页重写链路起点（脚本 → 分镜 → 素材引用），product 字段传递链路在此建立 |
| **P6** | 分镜脚本页 + ShotMaterialDialog（三 Tab） | 依赖 P5 的 product 传递；`stock_search` 联网素材在此落地 |
| **P7** | 素材检索页 | 独立页，可与 P5/P6 并行 |
| V3.1 | 桥接页逐页 Vue 重写替换 | 按 7 桥接页使用频率排序；备选池页面按需纳入 |

> 排期原则：骨架（P1）先行让形态落地 → 桥接（P2）补齐功能覆盖 → 原生页逐个交付（P3 定时任务管理 → P4~P7 高频页）。每个页面交付口径：对照原客户端 `studio/gui` 对应 .py 逐项行为核对 + IRON-04 单测 + 打包产物验证 + IRON-09 提交。

## 五、验证口径

- 每页实现均须通过：门禁（node --check + typecheck + 零残留）→ dev 环境手动验收（对照原客户端 `studio/gui` 对应 .py 行为逐项核对）→ 打包产物更新验证 → IRON-09 提交
- 四页为「核心链路」，须按 IRON-04 同步补单元测试（先红后绿）

---
*报告基于 2026-08-27 代码库实际状态核实生成；浏览器章节证据：commit 9d2bd9c / daff559 / 840cf7f / edf2a93。*
