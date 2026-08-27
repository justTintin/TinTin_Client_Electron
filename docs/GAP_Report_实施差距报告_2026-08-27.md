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

### 3.1 现状与 PRD 的形态分歧

当前 `/workbench`（[Workbench.vue](../desktop/renderer/src/views/Workbench.vue)）= **聊天会话形态**：
`WbComposer`（输入）+ `WbMessages`（消息流）+ `WbTaskDrawer`（任务抽屉）+ `WbNotificationDrawer`（通知）+ `WbSidebar`（会话列表）+ `useWorkbench{Chat,Sessions,Notifications,Tasks}.ts`

PRD §3.2 定义 = **16 页功能工作台**（侧边栏页面导航）。两者是不同的产品形态，需业务方裁决：**保留聊天形态 / 回归 16 页形态 / 聊天 + 页面混合**。

### 3.2 四个高频页（0/4）

| # | 页面 | 缺失关键点 | 接口就绪度 |
|---|---|---|---|
| 1 | 飞书脚本创作 | 无页面组件；`/script/list`、`/script/adjust-copywriting` 零调用；product{brand,model,category,name} 传递链路不存在 | 类型契约已生成 ✅ |
| 2 | 分镜脚本 | 无页面组件；相似度自动绑定 / 画幅下拉 / 保存联动刷新一键成片 均无 | 类型契约已生成 ✅ |
| 3 | ShotMaterialDialog | **整个对话框不存在**：素材库 Tab（角标多选/右键预览/品牌徽章）、MG动画跳转 Tab、联网素材 Tab（`stock_search` 零调用） | 类型契约已生成 ✅ |
| 4 | 素材检索 | 无筛选面板（文件类型/横纵比/分辨率/时长/品牌/型号/分类/Tag 云）与缩略图网格；`material_client.search` 零调用 | 类型契约已生成 ✅ |
| 5 | 成片任务 | 无 12 列表格（**总分列**优先级 `evaluation.total > quality_score.total > variants[0].score > task.*_score`）/ 全选+下载所选+打包所选 / 15s 自动轮询 / SSE 推送 | 类型契约 + SSE 通道 ✅ |

### 3.3 桥接页（12 页，未落地）

方案脚本 / 一键成片 / 成片任务队列 / 产品库 / 素材生成 / 音频素材 / 智能混剪 / 直播切片 等：PRD 的 `<webview src="http://127.0.0.1:8766">` + bridge.exe 过渡方案**无任何代码落地**。若 PySide6 客户端退役方向确定，建议评估**放弃 bridge.exe、直接按优先级逐页重写**，避免建设一条将被淘汰的过渡链路。

## 四、建议实施顺序

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | 业务方裁决工作台形态（聊天 vs 16 页 vs 混合） | 决定后续全部排期方向，阻塞项 |
| P1 | 成片任务页 | 最独立、无跨页依赖、接口+SSE 就绪，立即可做 |
| P2 | 飞书脚本创作 | 四页链路起点（脚本 → 分镜 → 素材引用） |
| P3 | 分镜脚本 + ShotMaterialDialog（三 Tab） | 依赖 P2 的 product 字段传递 |
| P4 | 素材检索 | 独立页，可并行 |
| P5 | 桥接方案取舍 | 依赖 P0 结论 |

## 五、验证口径

- 每页实现均须通过：门禁（node --check + typecheck + 零残留）→ dev 环境手动验收（对照原客户端 `studio/gui` 对应 .py 行为逐项核对）→ 打包产物更新验证 → IRON-09 提交
- 四页为「核心链路」，须按 IRON-04 同步补单元测试（先红后绿）

---
*报告基于 2026-08-27 代码库实际状态核实生成；浏览器章节证据：commit 9d2bd9c / daff559 / 840cf7f / edf2a93。*
