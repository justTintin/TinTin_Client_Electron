# 移植业务对齐清单（Business Alignment Checklist）

> 生成日期：2026-08-28 ｜ 基准：原客户端 `D:\Project\TinTin_AI_Agent_Main\studio`（PySide，gui 为主）+ `D:\Project\TinTin_AI_Agent_Main\apps\asset-browser`（原素材浏览器，Electron）
> 对照对象：本仓库 `desktop/`（Electron + Vue3 + TS）
> 性质：**纯文档，不改业务代码**。与 [GAP_Report_实施差距报告_2026-08-27.md](./GAP_Report_实施差距报告_2026-08-27.md)（实施进度视角）、[MIGRATION_V2_TO_V3_Full_Stack.md](./MIGRATION_V2_TO_V3_Full_Stack.md)（工程总纲）、[PRD_Electron_v3_SchemeA.md](./PRD_Electron_v3_SchemeA.md)（需求）互补：本文档只做**业务流程逐项对齐**，粒度到「触发入口 → 处理链路 → 产出 → 异常分支」。

## 〇、已裁决口径（本文档全部条目按此判定）

1. **LLM 凭证由服务端持有**：客户端不展示/不存储 Provider / API Key / Base URL（GAP §六，2026-08-28 已整改）。
2. **单一服务端地址**：electron-store `'server.url'` 单一键，保存即生效，自动 ping 总连通；各功能地址不再单独配置。
3. **按功能测试连接**：LLM(模型列表)/OCR(/material/ocr)/向量(/clip/health)/TTS(/voxcpm/health)/ASR(/whisper/health) 五端点，端点核对自 openapi-latest.json；无独立「LLM 测试连接」。
4. **模型列表服务端拉取**：GET /llm/models，客户端只选模型。
5. **定时任务入口在 WbSidebar 抽屉**（WbScheduledDrawer，本地/云端双 Tab）。
6. **bridge.exe / webview 桥接方案作废**：依赖 PySide6/Python，违反「不依赖本地 Python runtime」；相关页面由会话智能体承载。
7. 「解析并导入素材库」按裁决废弃（素材库接口未就绪，见 GAP §二）——素材入库类条目标注「待接口」。

**判定标记**：
- ✅ **对齐**：触发入口→处理链路→产出→异常分支与原客户端一致（含按 §〇 有意服务端化后语义不变者）
- 🟡 **部分对齐**：主链路存在但有子环节缺失
- ❌ **缺失**：整条业务链路未移植
- 🔶 **走样**：实现了但与原业务流程语义/口径不一致（含「有意偏差」需书面确认者）

---

# 一、工作台

## 1.1 原客户端业务流程（证据）

### A. 导航与范围
- 侧边栏分组：`gui/main_window_sidebar.py` L43-48「工作台」（页面 46）、L52-57「定时任务」（页面 47）、L61-65「素材浏览器」（**外开 Electron 应用**，非页面切换）、L98-104 方案脚本组（我的知识库/产品资料/产品文案创作/飞书脚本创作/分镜脚本创作）、L126-131 媒体库组（素材生成/素材检索/音频素材/媒体工具）、L153-158 成片制作组（成片任务/一键成片/智能混剪/直播切片）、L180-183 视频运营组、L201-208 底部「系统设置」（打开二级菜单窗口 `gui/system_settings_dialog.py` L36-192）。
- 16 页框架 + 懒加载：`gui/main_window_pages.py` L58-70（`_register_lazy_page`/`_ensure_page_built`）、L128-430（各 setup_xxx_page 注册表）。

### B. AI 对话（会话智能体）——`gui/agent_home_page.py`
**触发入口**：`_ChatPanel`（L1027-1056）挂在工作台页；顶部「模式切换」（智能体对话 agent / 通用对话 llm，L1068-1075）+「模型下拉」（tooltip：来自服务端 /llm/models，L1076-1079）+「清空对话」（L1081-1085）。

**处理链路（发送一条消息）**：
1. 输入：回车发送 / Shift+换行 / 拖拽文件入上下文（`_ChatInput` L138-221，`filesDropped` → `_add_attachment_files` L1176）；输入 `/` 唤起斜杠菜单（`_SlashPopup` L223-364：智能体与本地技能合并展示，确认后插入 `@agent` 前缀）。
2. 上下文选择（输入框上方工具行 L1099-1144，**胶囊条 L1146-1168：不删除则每轮持续携带，点 移除 删除**）：
   - 附件 → 本地文件入**服务端会话素材池**（tooltip L1106）
   - 产品 → 产品资料库单选（`_ProductPickerDialog` L810-877，摘要 `_product_summary` L1320-1334：品牌/型号/品类/货号+性能+卖点）
   - 素材 → 服务端素材库多选（`_MaterialPickerDialog` L878-956，`_material_summary` L1336-1350）
   - 脚本 → 服务端分镜脚本库（`_ScriptPickerDialog` L957-1026，`_script_summary` L1352-1366）
   - 「转编排任务」复选框（L1130-1135）：**默认勾选**，开启后 agent 对话以 mode=plan 提交（服务端先拆 plan 再自动执行，回复返回任务 ID）
3. 发送：`_on_send` L1230-1235 → `_send_text` L1237-1281：
   - 防重入（worker 运行中直接 return，L1240-1241）
   - `message = 用户输入 + "\n\n" + 上下文文本`（L1244-1246）；`_history` 追加用户原文并截断（L1247-1248）
   - 120s 超时定时器（L1251-1256，超时 `_on_busy_timeout` L1438-1445 恢复输入，回复迟到仍直接显示）
   - agent 模式：未入池的素材/附件打包 `ctx_payload`（L1266-1273）
4. 后台请求 `_ChatWorker.run` L614-656：
   - agent 模式（L616-641）：若携带素材/附件且无 session → `ac.create_session()`（失败抛「创建服务端会话失败」）→ 素材按 `material_id`、附件按 `file_path` 逐个 `session_attachment_add` 入池（L621-632）→ `ac.agent_chat(message, history, model, max_rounds=3, mode, session_id)`（L633-636）
   - llm 模式（L642-653）：`llm_proxy.llm_chat_messages`（DeepSeek 代理，temperature=0.4，timeout=180）
   - 异常：RequestException → `failed` 信号（L654-656）→ `_on_reply_failed` L1429-1436 气泡显示错误
5. 回复：`_on_reply_ok` L1368-1390：保存返回 `session_id`（**服务端会话续接**，L1374-1377）→ history 追加 assistant → 气泡更新 → `_detect_video_asset` L1392-1418（三级识别：绝对视频 URL → `/editor/render/{id}/result` 相对路径 → 「任务ID：#N」+成片语境兜底）命中则气泡挂**播放/下载按钮**（`_ChatBubble.set_asset_actions` L538-590）。
6. 重新生成：`_on_regenerate` L1291-1318（服务端无重生成接口 → 以新一轮对话重发，同时从 history 移除旧回复）；引用回复：`_on_quote` L1283-1289（Markdown 引用块插入输入框）。
7. 模型/智能体加载：`_ModelLoader` L686-697（GET /llm/models，失败发空数组）；`_AgentLoader` L699-726（GET /agent/agents，过滤 `exposed:false`）；智能体快捷条 `_AgentBar` L728-810（每行 10 个，多余折叠）。
8. **会话管理（原版口径：单会话 + 服务端续接）**：`_session_id`（L1046）全程一个；`clear_chat` L1213-1223 → `_reset_session` L1640-1648（`delete_session` 删除服务端会话，**素材池一并清理**）+ `_save_chat`；本地持久化 `data/agent_chat_history.json`（`_history_file` L1659、`_save_chat` L1661、`_restore_chat` L1675-1702：启动恢复消息并**以 session_id 续接服务端会话，素材池仍在服务端**，L1708-1713 恢复后未入池项重传）。

### C. 任务提交与结果回填
- **成片任务页** `gui/scheduled_tasks_page.py`：进入页自动刷新（`on_page_enter` L990 → `refresh` L272-356：并行拉服务端任务 + 评价数据 `_fetch_evaluations` L323）；行点击 → `get_task` 详情 `_on_task_row_clicked` L489-510 → `_render_detail` L512-610；variants 展示/反馈 L640-819；下载（单个/打包/全选/批量）L840-976；删除 L981；视频播放 `_VideoPlayerDialog` L45-117。
- **编排任务**：`utils/agent_client.py` L101 `create_task`（POST /agent/tasks，goal/plan/capability/mode）、L133 `list_tasks`、L155 `get_task`、L167 `update_task`、L204 `confirm_task`（waiting_user_input 节点人工确认）、L209-229 pause/resume/retry/cancel、L230/243 artifacts。
- **客户端任务下发闭环** `gui/client_task_thread.py` L14-61：每 5s `GET /tasks/assigned/{machine_id}` 领取 → `execute_task`（打开素材浏览器引导下载）→ `POST /tasks/{task_id}/report` 上报 ok/failed（L43-53）；异常仅告警继续轮询（L33-35）。

### D. 定时任务（local_scheduler + mgmt 页）
- **本地 Tab** `gui/scheduled_tasks_mgmt_page.py`：
  - 新建表单：名称/类型（hotspot 本地 / agent 云端智能体，`_on_type_changed` L277-283 切换显示任务描述区）/调度（每天|每周，`_on_mode_changed` L285-287）/时间/星期
  - 「拆解任务」`_on_split_plan` L289-321：`agent_router.build_plan(goal)`（`utils/agent_router.py` L125-126，LLM 拆解为服务端可执行 plan）→ 预览步骤 → **plan 随任务注册时存储**；失败提示「服务端 LLM 或注册表不可用」
  - 「注册」`_on_create` L323-370：agent 类型强制先拆解（L331-333）→ 后台 `ls.create_task`（schtasks）→ 成功提示「已写入 Windows 任务计划程序」
  - 「立即采集今日热点」`_on_capture_now` L372-382：`asset_browser_client.launch_hotspot_capture(auto_quit=True)`（`utils/asset_browser_client.py` L203+：写 `apps/asset-browser/handoff.json` 握手 → 启动素材浏览器自动逐平台采集，采完自动退出）
  - 列表 `_refresh_local` L384-424：schtasks 实时状态合并（下次/上次运行、上次结果：成功/尚未运行）；行操作：立即运行 L426-435（schtasks /run）、取消定时 L437-453（二次确认）
- **云端 Tab** `_build_server_tab` L225-274：一键成片定时任务跳转入口（L245-252）+ 最近编排任务表（目标/状态/进度/创建时间/操作）：`waiting_user_input` 确认 `_on_agent_confirm` L515-531、详情 `_on_agent_detail` L532-557、能力清单 `_on_view_agents` L558-583（GET /agent/registry）、分页 `_goto_page` L584-588。
- **调度内核** `utils/local_scheduler.py`：schtasks 注册（L134-191：`TinTinAI_` 前缀、daily/weekly、/st HH:MM、/d MON,WED；同名校验 L158；时间正则 L151）；**到点执行命令 = 内联 python -c**（L30-48：hotspot → `launch_hotspot_capture(auto_quit=True)`；agent → 从清单读本任务 `plan`（无则 `build_plan(goal)` 兜底）→ `ac.create_task(goal, plan, mode='execute')`）；持久化 `data/local_scheduled_tasks.json`（L27/68-88）；list 合并实时状态（L194-208）；delete/run_now（L211-231）。
- **异常分支**：schtasks 非 0 退出码回传 stderr（L174-176）；查询失败标记「未注册」（L205-207）；python.exe 缺失（L161-163）。

## 1.2 新客户端现状

| 能力 | 载体 | 现状证据 |
|---|---|---|
| 会话侧栏 | `renderer/src/views/Workbench.vue` + `components/workbench/WbSidebar.vue` | 260px 侧栏：新建会话/分组列表/底部（任务队列、通知中心、系统设置）；**定时任务按钮在 sidebar-top**（WbSidebar.vue L38-45，emit `open-scheduled`）→ 打开 WbScheduledDrawer 抽屉 ✅ 符合裁决 |
| 消息流/输入框 | `WbMessages.vue` / `WbComposer.vue` + `composables/useWorkbenchChat.ts` | **纯 mock**：初始消息硬编码 JBL 示例（useWorkbenchChat.ts L30-51）；`handleSend` L66-86 仅 push 用户消息 + `setTimeout` 500ms 模拟 AI 回复「收到你的需求…」。**零服务端调用**（全 renderer 无 `agent/chat`、`/llm/chat/completions` 消费；server-proxy.js L632 `llm:chat` handler 已存在但无人调用） |
| 会话数据 | `composables/useWorkbenchSessions.ts` | **纯前端示例数据** L31-37（s1~s5 硬编码）；`selectSession` L44-47 注释「实际项目中这里会拉取该会话的历史消息」；无持久化、无服务端 session |
| 任务队列抽屉 | `WbTaskDrawer.vue` + `useWorkbenchTasks.ts` | 真实服务端任务优先（tasksStore.page.items → `/tasks/unified` 映射）+ `SAMPLE_TASKS` 离线兜底 L15-19；打开时拉取一次，失败静默 L68-73 |
| 通知中心 | `WbNotificationDrawer.vue` + `useWorkbenchNotifications.ts` | 本地通知流（含任务完成等事件），未对照原版服务端任务事件源 |
| 定时任务抽屉 | `WbScheduledDrawer.vue` + `useScheduledTasks.ts` + `main/local-scheduler.js` + `main/agent-plan.js` + `main/hotspot-capture.js` | **完整移植**：本地/云端双 Tab（WbScheduledDrawer.vue L27/L65-68）；新建表单校验与原版同源（useScheduledTasks.ts L90-98）；拆解 `scheduled.splitPlan` → `agent:splitPlan` → `agent-plan.js`（对照 build_plan）；注册 `scheduled.create` → schtasks（local-scheduler.js L164-196，`/tr` 载体=应用自身 `--tintin-scheduled` 参数 L101-108，dev/packaged 双路径）；立即运行/取消/立即采集今日热点（`scheduled:captureHotspots` → 隐藏 BrowserView + CDP 拦截四平台热榜 + DOM 兜底 + 清单 `userData/hotspots/hotspots_sync.json`）；云端 Tab：/agent/tasks 根任务概览 + waiting_user_input 确认 + /tasks/unified/{id} 详情弹窗 + /agent/registry 能力清单 |
| 主进程调度 | `main/local-scheduler.js`、`main/main.js` L649-656 | `scheduled:list/create/run/delete` + `agent:splitPlan` + `scheduled:captureHotspots`；到点触发 `setupTriggerRelay`（hotspot=采集→切浏览器 Tab；agent=plan 优先提交，无 plan 回退拆解） |
| 断链订阅 | `App.vue` + `useBrowserNav.ts` L152-160 | `onScheduledHotspot` → `pendingHotspotNav` → 浏览器切 Tab 并导航 douyin/hot |

## 1.3 差距清单（工作台）

| # | 条目 | 判定 | 优先级 | 说明（对照点） |
|---|---|---|---|---|
| W1 | AI 对话发送→服务端→回复全链路 | ❌ 缺失 | **P1** | 原：agent_home_page.py L1237-1281 + L614-656（/agent/chat max_rounds=3、/llm/chat/completions）；新：useWorkbenchChat.ts L77-85 setTimeout 假回复。llm:chat IPC 已备（server-proxy.js L632）未接线 |
| W2 | 服务端会话续接 + 会话素材池 | ❌ 缺失 | **P1** | 原：create_session/session_attachment_add/remove/delete_session（agent_client.py L307-383）+ agent_home_page.py L621-632/L1626-1629/L1640-1648；新：无任何 session 概念 |
| W3 | 模型下拉（GET /llm/models）+ 模式切换（智能体/通用） | ❌ 缺失 | **P1** | 原：L1068-1079 + _ModelLoader L686-697；新：无模型选择、无 agent/llm 分流（llm:models IPC 已备 server-proxy.js L644） |
| W4 | 智能体列表/快捷条/斜杠菜单 | ❌ 缺失 | P2 | 原：L699-810 + _SlashPopup L223-364（GET /agent/agents + 本地技能合并） |
| W5 | 上下文四类选择器（附件/产品/素材/脚本）+ 胶囊持续携带 | ❌ 缺失 | P2 | 原：L1099-1168 + 三 Picker L810-1026 + 摘要拼接 L1320-1366 |
| W6 | 「转编排任务」开关（mode=plan 默认勾选） | ❌ 缺失 | P2 | 原：L1130-1135 + L635；定时任务抽屉已有同款拆解能力可复用 |
| W7 | 会话管理形态 | ✅ 已对齐（裁决：多会话补全） | 2026-08-29 落地：多会话保留 + 会话列表删除/重命名入口 + 每会话独立服务端 session_id（pickSessionServerId）+ workbench.sessions 本地持久化；删除同步 agent:sessionDelete；对齐原 delete_session/_reset_session |
| W8 | 回复含成片视频资产识别 + 气泡播放/下载 | ❌ 缺失 | P2 | 原：_detect_video_asset L1392-1418 + set_asset_actions L538-590（三级识别） |
| W9 | 重新生成 / 引用回复 / 120s 超时恢复输入 | ❌ 缺失 | P3 | 原：L1283-1289 / L1291-1318 / L1438-1445 |
| W10 | 任务队列抽屉 | 🟡 部分对齐 | P2 | 已接 /tasks/unified；但 SAMPLE_TASKS 兜底（useWorkbenchTasks.ts L15-19）会把演示数据当真数据展示，需离线显式标注；缺打开时 15s 自动轮询与 SSE（原成片任务页口径） |
| W11 | 客户端任务下发闭环（/tasks/assigned 领取→执行→report） | ❌ 缺失 | P3 | 原：client_task_thread.py L14-61；依赖素材浏览器引导下载，素材库就绪前可后置 |
| W12 | 定时任务管理（本地 schtasks 注册/查询/删除/立即运行 + 拆解入池 + 云端编排概览/确认/详情/能力） | ✅ 对齐 | P1（已闭环） | local-scheduler.js 与原 local_scheduler.py 同机制（schtasks+清单 JSON）；WbScheduledDrawer 两 Tab 对齐 mgmt 页两板块；P4 缺口（hotspot 断链/采集链路/plan 链路/详情弹窗）2026-08-28 已补（GAP §4.1） |
| W13 | 热点采集触发载体 | 🔶 走样（有意） | P3 | 原=外开素材浏览器进程自动采集后退出（asset_browser_client.py L203+）；新=主进程隐藏 BrowserView+CDP 采集（hotspot-capture.js）。行为口径一致（采集→清单→切 Tab），系 bridge 作废裁决的合规替换，**仅需书面确认** |

工作台统计：✅ 对齐 1 ｜ 🟡 部分 1 ｜ ❌ 缺失 9 ｜ 🔶 走样 2（合计 13 条）

---

# 二、浏览器

## 2.1 原客户端业务流程（证据）

原素材浏览器为**独立 Electron 应用** `apps/asset-browser/`（main.js / preload-webview.js / renderer/app.js），由主客户端经菜单外开并握手。

### A. 入口与握手
- 菜单入口：main_window_sidebar.py L61-65（菜单最顶部）+ `open_asset_browser` L217-226。
- 握手协议：`utils/asset_browser_client.py` L26 `HANDOFF_FILE`；`launch_for_topic(topic, keyword)` L123-156 写 handoff.json（含搜索词）→ 浏览器启动读取 `get-handoff`（main.js L160/L147-158）→ **自动打开对应平台并搜索**；`launch_dreamina_assets` L173-201（即梦资产下载目录指定）；`launch_hotspot_capture` L203+；`launch_knowledge_sync` L220+。

### B. 平台与内容抽取
- 平台表：app.js L1700-1706（B站/小红书/抖音/YouTube/TikTok，知乎注释隐藏）。
- webview 分区与事件：`setupWebviewListeners` app.js L847+；`web-contents-created` 安全策略 main.js L473+。
- 详情页判定：`isValidVideoPageUrl` main.js L1076-1092（决定嗅探是否出卡片）；`_cleanMediaUrlForDownload` L958-977。
- 嗅探：`addSniffedAssets` app.js L1315-1384、`renderSniffedAssets` L1525+、去重 `getCleanUrlForComparison` L1510。

### C. 素材下载
- `start-download` main.js L1094-1460：双流（视频+音频 `downloadStream` L827-957）→ 合并；yt-dlp 通道（`getYtdlpSpawnArgs` L115-132，参数含 cookie）；`douyin-download` L1725-1770（平台专用解析）；暂停/恢复/取消 L1462-1496/L1639；进度回写 `updateTaskProgress/Status/Size` L1659-1694（下载中/失败/取消全状态）。
- 下载目录管理：`db-get-download-dirs` L572-589（多目录）、`select-download-dir` L604-614、任务级 subdir。
- 下载记录：`db-get-downloads` L615-627、`db-clear-downloads` L620；右键菜单（打开文件/文件夹/查看日志/重试）app.js L253-297 `showDownloadContextMenu`/`showDownloadLog` L298-358。
- Cookie：`export-cookies-file` main.js L1795+（Netscape 格式导出，yt-dlp 可用）；`check-cookie-status` L1695-1724。

### D. 素材入库 / 知识库 / 每日素材
- 入库：`save-kb-items` main.js L191-212、`append-kb-manifest` L231-248、`enqueue-material-import` L713-765（采集文件登记导入任务 → 服务端素材库）；`syncKnowledgeBase` app.js L1737-1812（拉取清单→表格渲染→勾选下载 `downloadKnowledgeBaseItem` L1981-2177 → 入库）；KB 分页 KB_PAGE_SIZE L85。
- 每日素材：`get-daily-assets` main.js L766-826（按日期目录扫描）+ app.js `loadDailyMaterials` L2447+ / `renderDailyMaterials` L2340+ / 日期筛选 L2438 / 预览 L2314-2339。
- 达人/创作者：creators DB（`db-get-creators`/`db-add-creator`/`db-delete-creator` main.js L543-566）；`collectAllFromCreator` app.js L1258-1314（自动滚动加载 `_loadAllByScroll` L1176-1197 → 逐条嗅探下载）；`sniffAndDownloadVideo` L2185-2255。
- 收藏采集：`FAV_PAGES` app.js L1167-1175（各平台收藏页 URL）+ `captureFavorites` L1198-1257（逐平台打开收藏页→滚动→解析→**采集素材入库**）。

### E. 登录态与热点采集
- 登录状态：`check-login-status` main.js L1016-1041 → app.js `renderLoginStatusBadges` L1698-1736（每平台徽章，提示未登录导致抓不到数据）。
- 热点采集：`HOTSPOT_PAGES` app.js L1072-1078（四平台热榜页）→ `captureHotspots` L1118-1165（逐平台 webview 加载→`_hotspotDomScript` L1092-1117 DOM 解析→`autoScrollToBottom` L1038→`append-hotspot-manifest` main.js L171-189 追加 `outputs/materials/hotspots/hotspots_sync.json`）。

### F. 扩展 / 自动上架
- Chrome 扩展 `apps/browser-extension/`（background/content/sidepanel：网页端采集辅助）。
- 自动上架：`gui/auto_listing_tab.py`（外挂 Chrome CDP:9222 + bridge:8123）+ `utils/auto_listing/engine.py`（抖店数据包校验/复用登录/填写/保存草稿/截图日志/断点续跑，V2 PRD 十四章口径）；`gui/extension_page.py` + `utils/extension_bridge.py`/`ext_installer.py`（下载插件配置）。

## 2.2 新客户端现状

| 能力 | 载体 | 证据 |
|---|---|---|
| 平台浏览 | `views/Browser.vue` + `composables/useBrowserNav.ts` + `main/thick-shell-viewpool.js` | 7 平台（douyin/bilibili/kuaishou/xiaohongshu/weixin/youtube/jimeng，useBrowserNav.ts L171-178）+「网页浏览器」+ ext 组（自动上架/收藏记录 L197-204）；BrowserView 池懒创建、`persist:tintin-*` 分区隔离（thick-shell-viewpool.js L17/L54-82）、崩溃恢复 ≤3 次（L319-353）、前进/后退/刷新/地址栏跳页 |
| 媒体嗅探 | thick-shell-viewpool.js L127-147 + `main/media-sniff-utils.js` | onHeadersReceived + 详情页白名单 `isDetailPage`（platform-meta.js）；`skipped: NOT_DETAIL_PAGE` 下发过滤 |
| 平台抽取器 | `main/extractors/`（bilibili/douyin/kuaishou/weixin/xiaohongshu/_common） | 各平台详情页解析 |
| 素材下载 | `main/media-downloader.js` + `main/download-manager.js` | `browser:downloadMediaStart` L303（双流/yt-dlp/ffmpeg 合并、cookie 注入 yt-dlp L347-401 Netscape 临时文件、取消/暂停 L552-570、快照 L570）；任务注册表单一真相源 + `downloads-history.json` 300 条上限（download-manager.js L16-42）；默认 Windows 下载文件夹 + 浮窗管理（打开/位置/删除/清完成/改路径） |
| B站扩展 | `main/bilibili-ext.js` + ext-manager.js | 预装扩展 + 手动注入 + 链接提取双通道（executeJavaScript 轮询为主 + console-message 冗余）；逐 session 加载保持登录态隔离（ext-manager.js L4） |
| Cookie | media-downloader.js + preload.js L251-252/L349 | cookieList/Clear/exportCookies（Netscape） |
| 收藏 | `useBrowserFavorites.ts` + `main/media-storage.js` | **网页 URL 收藏夹**（addFavorite/removeFavorite/collectCurrentPage L92-105、点击跳转 navigateToFavorite L107）；经 mediaStorage IPC 持久化 |
| 历史 | main.js L698-706 `history:get/clear` + useBrowserDownloads `historyEntries/addHistory/navigateToHistory/openHistoryPanel` | did-navigate 回填地址栏时写入历史（Browser.vue L154-161） |
| 热点采集 | `main/hotspot-capture.js` + local-scheduler `setupTriggerRelay` + useBrowserNav `navigateToHotspot` L152-160 | 隐藏 BrowserView + CDP debugger 拦截四平台热榜 API + DOM 兜底 + 清单追加 + 到点断链（App.vue 订阅 onScheduledHotspot → 切 Tab 导航） |
| 自动上架 | `components/browser/AutoListingView.vue` + `useAutoListing.ts` | ext 组「自动上架」按钮位于收藏记录上方（useBrowserNav.ts L203-204）✅ 符合裁决；但 useAutoListing.ts **仅关键词配置**（readCfg/writeCfg `ext.shopKeyword` L19-28）——执行引擎未实现 |
| 扩展管理 | 🧩 面板 + extensions-panel.html + ext-manager.js | 已覆盖原「下载插件」的扩展安装/管理职责（GAP §3.4 表 #5） |

## 2.3 差距清单（浏览器）

| # | 条目 | 判定 | 优先级 | 说明 |
|---|---|---|---|---|
| B1 | 平台浏览/分区隔离/崩溃恢复/导航工具栏 | ✅ 对齐 | — | 平台集比原版多（+快手/视频号/即梦），符合内置化方向 |
| B2 | 媒体嗅探（详情页白名单/skipped 过滤/去重） | ✅ 对齐 | — | 对照原 isValidVideoPageUrl + addSniffedAssets 口径 |
| B3 | 素材下载（双流/yt-dlp/合并/暂停恢复/进度/历史/浮窗） | ✅ 对齐 | — | 对照原 start-download/updateTask* 全状态口径 |
| B4 | B 站下载助手扩展 | ✅ 对齐 | — | 预装+注入+双通道提取 |
| B5 | Cookie（分区隔离 + Netscape 导出） | ✅ 对齐 | — | 对照原 export-cookies-file |
| B6 | 热点采集（到点断链+手动采集+清单+切 Tab） | ✅ 对齐 | — | P4 已闭环（GAP §4.1）；载体替换见 W13 |
| B7 | 收藏语义 | ✅ 已对齐（裁决：双入口区分） | 2026-08-29 落地：侧栏「收藏记录」→「网页收藏」（URL 收藏夹，空态语义说明）；新增「素材采集」入口跳达人库采集清单 Tab 走 B8 入库（collectMode）；对齐原 FAV_PAGES 素材采集语义 |
| B8 | 采集素材入库（save-kb-items/enqueue-material-import → 服务端素材库） | ❌ 缺失（待接口） | P2 | 按裁决废弃「解析并导入素材库」；**素材库接口就绪后必须补**：采集文件 → 登记导入任务 → 服务端素材库，否则工具/工作台无素材可引用 |
| B9 | 每日素材（按日期扫描+预览+筛选） | ❌ 缺失 | P3 | 原 main.js L766-826 + app.js L2340-2447 |
| B10 | 达人/创作者库 + 主页全量采集 | ❌ 缺失 | P3 | 原 creators DB L543-566 + collectAllFromCreator L1258 + 自动滚动加载 |
| B11 | 平台登录状态徽章 | ❌ 缺失 | P2 | 原 check-login-status L1016 + renderLoginStatusBadges L1698；嗅探/下载强依赖登录态，缺提示时失败难排查（原版明确用徽章预防） |
| B12 | 自动上架执行引擎 | 🟡 部分对齐 | **P1** | 入口/关键词已迁入浏览器 ✅；但引擎（复用 `persist:tintin-*` 已登录会话：登录校验→数据包校验/复用→表单填写→保存草稿→截图日志→断点续跑，V2 PRD 十四章口径）未实现，AutoListingView 现为配置占位 |
| B13 | 入口形态与主题搜索直达 | 🔶 走样（有意） | P3 | 原=外开独立应用+handoff.json 握手（关键词自动搜索 launch_for_topic L123-156）；新=内置 Tab。集成方向合规；「从工作台/会话带关键词直达搜索」的握手语义暂无等价物（可由 W1 会话智能体工具调用承载） |

浏览器统计：✅ 对齐 6 ｜ 🟡 部分 1 ｜ ❌ 缺失 4 ｜ 🔶 走样 2（合计 13 条）

---

# 三、媒体工具

## 3.1 原客户端业务流程（证据）

**入口**：`gui/media_tools_page.py` L89-102 三组卡片——图形：封面制作/图像抠图（L90-91）；视频：**视频修复**/视频转文字/声音克隆/视频去水印字幕（L94-97）；提示词：图片反推/视频反推（L100-101）；点击卡片切入子页（L175-189），懒构建 L191-205，右上角「← 返回媒体工具」L213-218。

### ① 图像抠图 `gui/image_matting_page.py`
- 入口：选图 `choose_image` L316（预览 L82-156）→「开始抠图」`run_matting` L346。
- 链路：`RembgWorker` L28-80（**本地 rembg 推理**，模型 u2net，进度回调）→ `on_worker_finished` L375（成功显示结果预览）→ `save_cutout` L397 落盘。
- 异常：模型/推理失败经 err_msg 提示（L375-395）。
- 新客户端处置：本地 rembg → 服务端 /rembg（V3 不可捆 Python 的有意服务端化）。

### ② 视频转文字 `gui/transcription_page.py`
- 入口：多文件列表 `_add_paths/_add_files` L509-545（拖拽/选择，行内状态色 `_apply_row_color` L695-709）。
- 链路：`_start_batch` L1006-1038（逐文件排队）→ `BatchWorker` L1063-1074（asr_client 远程转写，language 参数）→ `_on_file_done` L1108-1133（SRT 生成 + 行状态）→ **字幕预览** `_render_subtitle_html` L322-359（词级 HTML）→ **点击词跳转播放** `_on_word_clicked` L360-406 + `_highlight_current_word` L418-452（`_ensure_playing_file` L407）。
- 编辑与润色：双击编辑模式 `_enter_edit_mode/_apply_edits` L790-888 → **LLM 重写对话框** `_show_rewrite_dialog` L588-676（改写后 `_plain_to_srt` L678 回写时间轴）→ 保存 `_show_save_dialog` L915-973（格式转换 `_convert_format` L975-1005：srt/vtt/txt）→ 失败重试 `_retry_transcribe` L763。
- 异常：`_on_file_error` L1134-1140（行级错误色 + 重试入口）。

### ③ 声音克隆 `gui/voice_clone_page.py`
- 入口：音色来源二选一——音色视频目录 `_select_voice_video_dir` L414-492（ASR 转写生成参考文本）或参考音频样本库 `_populate_ref_audio_samples` L613-683（内置样本/自定义/试听 `_play_ref_audio` L685/**转写参考音频** `_transcribe_ref_audio` L690-743：ASR → LLM 标点 `PunctuationLLMWorker` L38-56）。
- 链路：文案表增删行 L494-609 → 分句：`_split_and_populate_manually` L791-874（ASR 对齐 → LLM 分句 `SentenceSplitterLLMWorker` L57-84 → **校验** `_validate_llm_split` L961-975 → 短句合并 `_merge_short_fragments` L890-960，按字数上限 `_estimate_max_chars` L878-889）→ 逐行生成/试听/导出 L1043-1053（voxcpm_client）。
- 异常：分句校验失败回退手工；生成失败行级提示。

### ④ 视频去水印字幕 `gui/subtitle_removal_page_v14.py`
- 入口：选视频 `_select_video` L928 → **预览帧上交互框选**：`InteractivePreviewLabelV14` L254-532（quad 四点框：拖拽顶点/旋转/多框管理 `_add_box/_delete_box` L1104-1131、框列表 `_update_box_list_widget` L1059、滑杆同步 `_sync_sliders_to_active_box` L1070）。
- 参数：模式（智能/框选）L1025-1031、用途（字幕/水印，决定 inpaint 策略）`_get_purpose` L1033-1047、水印文字参数（构造参数见 worker 签名 L84：`sub_areas, inpaint_mode, output_path, purpose, watermark_text`）。
- 链路：`start_removal` L1252 → `_start_remote_removal` L1284-1346 → `RemoteVSRWorkerV14` L76-252（**上传进度** `_ProgressFileReader` L57-72/L144、POST 服务端 VSR、结果下载 `_download` L232-253）→ `on_worker_finished` L1363 打开输出；`stop_removal` L1347-1352 取消（worker.stop → 服务端取消 L104-116）；进度/日志回调 L1354-1361。
- 异常：上传中断/服务端 5xx/取消中途态。

### ⑤ 封面制作 `gui/cover_maker_page.py`
- 入口：画布 + 图层面板（图层增删/排序/显隐/不透明度/缩放 L572-735）+ 画幅/安全区 L492-559（几何记忆 `_save_geom/_load_geom` L536-559）。
- 素材来源：模板库加载 `CoverTemplateLoadWorker` L110-141 / 上传模板并导入图层 L799-883 / 源图上传 L735/**一键抠图** L743-764（联动抠图能力）/**即梦生成** L765-798。
- AI 能力：AI 文案 `CoverTextAIWorker` L142-182（LLM 生成标题/副标题 `_ai_suggest` L898+）/ AI 布局 `CoverLayoutAIWorker` L183-224。
- 产出：导出封面图；异常：AI 失败回退手工编辑。

### ⑥ 图片/视频反推提示词 `gui/prompt_reverse_page.py`
- 图片：`_ImagePromptWorker` L422-458（POST /prompt/image）→ 结构化结果 `_format_result` L101-127。
- 视频：**时间轴组件** `_VideoTimeline` L210-420（抽帧 16 帧 `_extract_frames` L73-95 + 波形 `_gen_waveform` L245）→ 鼠标框选 ≤30s 片段 `get_range` L278-301 → `_VideoPromptWorker` L461+（POST /prompt/video，start_sec/end_sec）→ 轮询 `_poll_task_result` L128-188（600s 超时/3s 间隔/任务 id 提取 L189-194）。
- 异常：超时/无 task_id/服务端错误分支齐全。

### ⑦ 视频修复
- `gui/main_window_pages.py` `setup_video_tools_page` L430-497：后端选择（ComfyUI 本地/局域网，L448-452）→ **工作流选择**（assets/workflow，默认「输入视频-修复脸部细节-20260113.json」L492-497）→ 选视频 → `run_video_tool_task` L486 提交；工作流状态标签 L461。

### ⑧ 智能混剪 / 直播切片（原属「成片制作」组，新客户端归入媒体工具）
- 智能混剪 `gui/video_montage_page.py` + `gui/montage/`：四步向导——step1 切分（`step1_split_controller.py`/`step1_split_view.py`，split_workers）→ step2 拼接（`step2_concat_view.py`，concat_workers / 服务端 montage_concat_server_worker）→ step3 配音（`step3_voice_view.py`，voice_workers）→ step4 成片（`step4_final_view.py`）；另有卡点混剪 `beat_montage_controller.py`/`step_beat_view.py`、脚本生成 `script_workers.py`/`desc_workers.py`。
- 直播切片 `gui/live_clip_page.py` + `gui/live_clip/`（page/dialogs/widgets/utils/workers 分层）。

## 3.2 新客户端现状（载体与调用证据）

| 工具（新卡） | 对应原页 | 实际调用 | 证据 |
|---|---|---|---|
| ImageMatting.vue | image_matting_page | `server.rembgSubmit` + useServerTask 2s 轮询 /tasks/{id} + 通知 + revealInFolder | L55/L75；useServerTask.ts L99-128 |
| VideoTranscribe.vue | transcription_page | 单文件或 URL → `server.asrTranscribe` → 文本/blob 下载 | L55-110（L64/L71 两种提交） |
| VoiceClone.vue | voice_clone_page | `server.ttsVoicesList/ttsVoicesSamples/ttsGenerate` + useServerTask | L64-123 |
| SubtitleRemoval.vue | subtitle_removal_page_v14 | `ffmpeg.extractThumb` 缩略图 + `server.vsrRemove` 提交 | L40/L180-203 |
| CoverMaker.vue | cover_maker_page | `server.workflowRun` + `server.sse` 收进度 → 封面列表 | L102-153 |
| ReversePromptImage.vue / ReversePromptVideo.vue | prompt_reverse_page | `server.visionReversePrompt` | L59 / L61 |
| VideoRepair.vue | setup_video_tools_page | `server.workflowRun`（仅提交 + 「任务已提交」通知） | L57-67 |
| VideoMontage.vue | video_montage_page + montage/ | `server.montageConcat` + `server.ttsVoicesList/ttsGenerate` + `ffmpeg.concatSegments` 本地拼接 | L119-213 |
| LiveClip.vue | live_clip/ | `ffmpeg.extractAudio/probe/cut` + `server.asrTranscribe` | 文件头注释 L6 |

## 3.3 差距清单（媒体工具）

| # | 条目 | 判定 | 优先级 | 说明 |
|---|---|---|---|---|
| M1 | 图像抠图（选图→服务端处理→轮询→保存/打开目录→失败通知） | ✅ 对齐 | — | 处理位置本地 rembg → 服务端 /rembg 为 V3 有意服务端化（MIGRATION §1.4），链路语义（输入/产出/异常通知）一致 |
| M2 | 视频转文字 | 🟡 部分对齐 | P2 | 已对齐：选文件/URL→转写→文本+下载。缺：**多文件批量队列**（原 L1006-1140）、**字幕预览词级点击跳转播放**（原 L322-452）、**SRT 编辑 + LLM 润色回写**（原 L588-888）、格式转换 srt/vtt/txt（原 L975）、行级失败重试（原 L763） |
| M3 | 声音克隆 | 🟡 部分对齐 | P2 | 已对齐：音色列表/样本/生成/轮询。缺：参考音频 **ASR 转写取词**（原 L690-743）、**LLM 分句+校验+短句合并**（原 L791-975，长文案逐句合成的核心预处理）、**逐行生成/试听/导出表格**（原 L494-609/1043-1053） |
| M4 | 视频去水印字幕：quad 框选交互 | 🔶 走样 | **P1** | 原核心输入=预览帧上四点框选（拖拽/旋转/多框/用途/水印文字，L254-532/L1025-1047），`sub_areas` 直接决定服务端处理区域；新=缩略图预览+直接提交（L40/L180），**无框选 → 服务端只能按智能模式盲处理**，输出质量不可控。另缺上传进度（原 `_ProgressFileReader` L57-72）与主动取消（原 stop L104-116） |
| M5 | 封面制作 | ✅ 已对齐（裁决：接受模板渲染） | 2026-08-29 落地：保持服务端模板渲染链路 + 封面模板输入 + AI 标题/副标题（llm:chat）；模板列表接口契约未就绪（后置登记）；/workflow/run 契约缺失待服务端核对 |
| M6 | 反推提示词（图/视频） | 🟡 部分对齐 | P2 | 图片对齐；视频缺**时间轴抽帧+波形+框选 ≤30s 片段**（原 L210-420，start_sec/end_sec 是 /prompt/video 必要入参语义）与**任务轮询**（原 L128-188）；缺结构化结果分段展示 `_format_result` 口径核对 |
| M7 | 视频修复 | 🟡 部分对齐 | P2 | 仅 workflowRun 提交+通知（L57-67）；缺：**工作流选择**（原 L457-465 默认修复脸部细节）、**任务轮询/结果回填/下载/打开目录**（原版经 workflow_client 有完整闭环）、失败分支 UI |
| M8 | 视频混剪 | 🔶 走样 | P2 | 原四步向导（切分→拼接→配音→成片）+ 卡点混剪 + 脚本生成，且拼接走服务端（montage/concat_workers + montage_concat_server_worker）；新=concat+tts+**本地 ffmpeg 拼接**（VideoMontage.vue L119-213）。server-proxy 已备 `montage:split/beatSync/concat`（L689-733）仅用了 concat。本地并行处理涉嫌违反 IRON-11（任务调度走服务端），需裁决并改回服务端链路 |
| M9 | 直播切片 | 🟡 部分对齐 | P3 | 已接 ffmpeg+ASR；缺原 live_clip/ 的多段切片策略/对话框/worker 分层能力；同样存在本地 ffmpeg 处理 vs 服务端的口径问题 |
| M10 | 工具产出素材流转 | ❌ 缺失（待接口） | P3 | 原版工具产物（抠图/转写 SRT/配音）可被工作台上下文、素材检索、成片引用；新客户端产出只落本地目录。依赖 B8 素材入库 |

媒体工具统计：✅ 对齐 1 ｜ 🟡 部分 5 ｜ ❌ 缺失 1 ｜ 🔶 走样 3（合计 10 条）

---

# 四、系统配置

## 4.1 原客户端业务流程（证据）

### A. 入口与分区
- 底部「系统设置」入口：main_window_sidebar.py L201-208 → `open_system_settings` L253-256。
- 二级菜单窗口 `gui/system_settings_dialog.py` L36-192：菜单=平台接入/本地配置/扩展插件/任务队列/关于（L25-35 定义）；**平台接入页内嵌双 Tab：「LLM 设置」+「服务接入」（原模型配置页 reparent 注入，L112-133）**；切页触发刷新 `_trigger_refresh` L163-190；页面常驻复用、关闭仅隐藏（L37-45/L192）。

### B. 统一服务端地址与配置联动（关键证据）
- `gui/main_window_aiconfig.py` `_collect_all_config_from_ui` L26-75：任何保存动作前先从**所有** UI 收集（防过期内存值覆盖，注释 L29-31）——voice_clone_addr（L33-36）、llm_provider/api_key/api_url/model（L38-45）、llm_vision_api_url（L47-48）、**compute_server_url（统一服务端地址，L49-52）**、whisper/clip/ocr 地址（L53-63）、vox 地址与参数（L64-73）+ `vox_source=remote / vox_mode=api` 写死（L74-75）。
- `_on_server_url_changed` L89-114：服务端地址变更**即时联动**——vision/whisper/clip/ocr 直接同步统一地址，VoxCPM 追加 `/voxcpm/tts` 后缀。
- `_save_all_ai_config` L77-87（「保存全部」）；`save_llm_config` L15-24。
- 模型配置页：main_window_pages.py L670-739：顶部「服务端地址（统一配置）」输入 + 保存全部；**`llm_api_key_input` 已 `setVisible(False)` 隐藏（L724-726，注释：API Key 已隐藏，保留属性避免保存/测试代码崩溃）**——原客户端即不在客户端展示 API Key。
- LLM 设置页：`setup_llm_settings_page` L904-990；provider 切换 `main_window_aiconfig.py` `_on_llm_provider_changed` L227-256。
- 模型列表：agent_home_page `_ModelLoader` L686-697（GET /llm/models）——**模型列表自服务端拉取**。

### C. 按功能测试连接（main_window_aiconfig.py）
- LLM：`_test_llm_connection` L257-268 → `_create_proxy_test_worker` L269-296（**经服务端代理**发请求，不在客户端直连 LLM）。
- Vision L297-336、VoxCPM `_test_vox_connection` L337-372（/voxcpm/health）、Whisper L373-408（/whisper/health）、CLIP L409-444（/clip/health）、OCR L445-480（/material/ocr）；结果写各状态标签（成功绿/失败红，各 _on_done）。
- 环境状态联动：`refresh_llm_page_status` L116-129（env_config_tool 缓存 + 异步刷新 + 内置 Ollama 检测 `_ollama_refresh_status`）。

### D. 环境配置页 `gui/env_config_page.py`
- 检测：`check_environment` L412-513（Python/PyTorch/CUDA/GPU L422-435、**ffmpeg 检测** L462、PaddleOCR L492、硬件配置 L507）；编解码检测按钮 L232；Python&GPU 刷新 L167。
- 一键修复：`EnvInstallWorker` L31-55（官方源安装 CUDA 12.1 PyTorch，分阶段 stage 提示）→ 刷新环境状态。
- 素材目录：`_choose_materials_dir/_reset_materials_dir` L381-410。
- Ollama：utils/ollama_manager.py + llama_health.py（内置服务启停/检测）。
- 其它设置页（main_window_pages.py）：任务队列页 L1246-1478（本地任务列表+服务端任务同步 `_sync_server_tasks_async` L1343-1434 + 新增/清空）；账号页 L1479-1562（抖音账号/日志 Tab/系统信息 Tab）；关于页 L1622-1844（版本网格/MAC 复制 `copy_mac` L1698）；本地配置 Tab L1931-2040（**自启动** `_on_autostart_toggled` L1956-1972 / 缓存目录 L2016-2040）；LUT 配置 L2041-2120；数字人 Tab L990-1245；飞书配置 `main_window_aiconfig.py` `load/save_feishu_config` L537-583 + `_test_feishu` L584；即梦登录 `_dreamina_login/_dreamina_check` L481-536（扫码轮询登录态）。

## 4.2 新客户端现状

| 分区（Settings.vue L26-32） | 载体 | 现状证据 |
|---|---|---|
| 平台接入（服务端·模型） | `components/settings/CardPlatform.vue` + `composables/useSettingsGeneral.ts` | **2026-08-28 已按裁决整改**：单一 `'server.url'`（useSettingsGeneral.ts L40/L121-134：保存→`pingServer` 总连通→`fetchLlm` 自动拉模型列表 `applyModels` L81-99）；按功能测试 `perFunctionTest/testFunction/funcResults` L44-53（5 端点见 GAP §6.3 表）；Provider/API Key UI 与 `llm:providers` IPC 已全删（GAP §6.4）✅ |
| 本地配置 | Settings.vue L154-187（数据目录/字体/代理 Tab，useSettingsGeneral L18） | 只读展示数据目录等，无自启动/缓存目录改选 |
| 外观主题 | CardTheme.vue | 新增（原 theme_manager 亮暗） |
| 环境与维护 | CardEnvMaint.vue + `main/env-ipc.js` | restartService/clearCache/日志（useSettingsGeneral L136-153）；**无原版环境检测矩阵** |
| 本地推理能力（A2） | CardA2Inference.vue + `useInferenceSettings.ts` + `main/inference-router.js` + `a2-ipc.js`（12 条 IPC：config2+model4+inference2+ocr1+knowledge3，main.js L567-583）+ `model-manager.js`（模型下载）+ `ocr-local.js` + `vector-store.js` | 三模式推理路由/本地 OCR/本地向量知识库，且核查无独立服务端地址输入（GAP §6.3 #4）✅ |
| 关于 | CardAbout.vue | 版本信息 |
| 已移除 | 扩展插件卡 | 按裁决整体移除（Settings.vue ext 菜单项 + CardExtensions.vue + useSettingsExtension.ts，GAP §3.4）✅ |

## 4.3 差距清单（系统配置）

| # | 条目 | 判定 | 优先级 | 说明 |
|---|---|---|---|---|
| S1 | 单一服务端地址：保存即生效 + 总连通 ping + 模型列表自动拉取 | ✅ 对齐 | — | 对照原 `_collect_all_config_from_ui` L26-75 / `_on_server_url_changed` L89-114 语义（原版为「联动各功能地址字段」，新版收敛为单键，语义等价且更收敛） |
| S2 | 按功能测试连接（LLM/OCR/CLIP/voxcpm/whisper 五端点） | ✅ 对齐 | — | 对照原 `_test_llm/_test_vox/_test_whisper/_test_clip/_test_ocr` L257-480；端点核对 openapi |
| S3 | LLM 凭证服务端持有（无 Provider/API Key 展示与 IPC） | ✅ 对齐 | — | 原版本就隐藏 API Key（main_window_pages.py L724-726）；新版连字段一并移除，超出原版口径但符合裁决 |
| S4 | A2 本地推理（三模式路由/本地 OCR/本地向量/模型下载管理） | ✅ 对齐 | — | 原版对应内置 Ollama 检测 + llama_health；新版扩展为完整 A2 体系（新能力，非走样） |
| S5 | 环境检测与一键修复 | 🟡 部分对齐 | P2 | 原=全量检测矩阵（Python/PyTorch/CUDA/ffmpeg/编解码/PaddleOCR L412-513）+ 一键修复（L31-55）+ 素材目录选择（L381-410）；新=重启服务/清缓存。V3 无 Python 后检测矩阵需重新定义口径（建议：ffmpeg/onnxruntime/已下载模型完整性/A2 依赖自检 + 修复=重新拉模型），当前「环境与维护」名不副实 |
| S6 | 飞书配置（app_id/secret/token/table + 测试连接） | ❌ 缺失 | P2 | 原 load/save_feishu_config + _test_feishu（main_window_aiconfig.py L537-583）；ai_script_page 的飞书话题同步（L728-763）依赖它；会话智能体承载脚本创作后仍需凭证落点（建议：服务端持有，客户端只测连） |
| S7 | 即梦登录（扫码轮询登录态检测） | ❌ 缺失 | P2 | 原 _dreamina_login/_dreamina_check L481-536；新浏览器含「即梦AI」平台 Tab，无登录态入口则平台功能不可用 |
| S8 | 数字人 / ComfyUI / RunningHub 等平台接入配置 | ❌ 缺失 | P3 | 原 main_window_pages.py L990-1245（数字人 Tab）等；按「会话智能体承载」裁决可后置，但需在文档登记 |
| S9 | 账号页（抖音账号/日志/系统信息）、自启动、缓存目录改选、LUT 配置 | ❌ 缺失 | P3 | 原 main_window_pages.py L1479-1562/L1931-2040/L2041-2120 |
| S10 | 任务队列设置分区 | 🔶 走样（有意） | P3 | 原=设置内独立任务队列页（本地任务表+服务端任务同步 L1246-1478）；新=工作台任务抽屉承载（W10）。承载点变更合理，但注意 W10 的兜底/轮询缺口 |

系统配置统计：✅ 对齐 4 ｜ 🟡 部分 1 ｜ ❌ 缺失 4 ｜ 🔶 走样 1（合计 10 条）

---

# 五、跨区共性问题汇总

1. **「有 IPC 无 UI」与「有 UI 无 IPC」双断层**：server-proxy.js 已备 26+ 业务 handler（llm:chat L632、llm:models L644、montage:split/beatSync/concat L689-733、material:stockSearch L667、storyboard:* L734+ 等），渲染层多数未消费（工作台聊天 mock、混剪只用 concat）；反向如 VideoRepair 只用通用 workflowRun。**整改抓手：建立 handler→消费者映射表，逐条接线或明确废弃**。
2. **提交后无回填**：VideoRepair（提交即完）、M4/M6（缺轮询/下载）——原版全部任务型功能都有「提交→轮询→下载/打开目录→失败重试」闭环（对照 scheduled_tasks_page.py / prompt_reverse_page.py L128-188）。
3. **异常分支弱化**：原版每步有 QMessageBox/行级状态色/重试入口/超时恢复；新版多为一次性通知或静默 catch（useWorkbenchTasks L72、useScheduledTasks 部分支路）。补齐口径：每个触发入口至少覆盖「网络失败/服务端 5xx/参数校验失败/用户取消」四类。
4. **演示数据与真实数据混排**：任务队列 SAMPLE_TASKS、会话列表假数据——违反「业务对齐」的第一观感，且离线兜底无「演示」标注，会被当成真实业务失败。
5. **强交互输入被表单化**：字幕 quad 框选（M4）、视频时间轴选段（M6）、封面画布（M5）——这些交互直接决定服务端处理入参，省略即业务走样。
6. **素材流转断链**：浏览器采集（B8）→素材库→工作台上下文/工具输入的闭环全线待接口；在此之前各工具产物只能落本地。
7. **本地并行处理嫌疑**：VideoMontage/LiveClip 在渲染层直调 ffmpeg 拼接，与 IRON-11（任务调度走服务端）冲突，也与原版「拼接走服务端」口径相悖（M8/M9）。

# 六、整改排期建议（2026-08-28 二次裁决：按功能性质分线，不按差距大小排优先级）

> **裁决**：优先级排序只针对「移植对齐线」——即原客户端（PySide 脚本端）已有、需要移植对齐的功能。
> **自动上架、运营类需求属于新增需求，不属于移植**，单列「新增需求线」按运营节奏排期，不占用移植线的优先级。
> 判定口径：原客户端 `gui/*.py` 中存在对应业务 = 移植线；原客户端不存在 = 新增需求线。

## 移植对齐线（主线）

| 批次 | 内容 | 依据条目 | 预估 |
|---|---|---|---|
| **P1（第 1-2 周）** | ① 工作台真实对话链路：/agent/chat + /llm/chat/completions 接线（llm:chat IPC 已备）、模型下拉（/llm/models）、服务端会话续接 + 素材池、转编排任务开关；② SubtitleRemoval 补 quad 框选交互（sub_areas 入参）+ 上传进度 + 取消 | W1/W2/W3、M4 | 2 周 |
| **P2（第 3-5 周）** | ③ VideoTranscribe 批量队列 + SRT 编辑/润色/格式转换；④ VoiceClone 参考音频转写 + LLM 分句/校验/逐行生成；⑤ VideoRepair 工作流选择 + 轮询回填下载；⑥ VideoMontage 恢复服务端四步链路（接 montage:split/beatSync，移除本地拼接）；⑦ ReversePromptVideo 时间轴选段；⑧ 浏览器登录状态徽章；⑨ 收藏语义裁决落文案；⑩ 飞书/即梦登录配置进设置；⑪ 环境检测口径重定义（ffmpeg/onnxruntime/模型完整性自检）；⑫ 任务队列去 mock 混排（演示标注）+ 轮询 | W4-W7/W10、M2/M3/M5-M8、B7/B11、S5-S7 | 3 周 |
| **P3（按需/待接口）** | ⑬ 素材入库链路（素材库接口就绪后：采集→登记→服务端，打通 M10/B8）；⑭ 每日素材/达人采集；⑮ 客户端任务下发闭环；⑯ 智能体快捷条/斜杠菜单/上下文胶囊全量对齐；⑰ 账号页/自启动/缓存目录/LUT；⑱ LiveClip 服务端化增强 | W5/W8/W9/W11、B9/B10/B8、M9/M10、S6 残余/S9 | 按接口节奏 |

## 新增需求线（单列，不占移植排期）

| 条目 | 性质 | 排期口径 |
|---|---|---|
| B12 自动上架执行引擎 | 新增需求（运营类） | 按运营上线节奏单独排期，与移植线并行不互斥 |
| 后续运营类需求 | 新增需求 | 同上；进入前先在本文档登记归类，避免与移植对齐混淆 |

> 每批次的验收口径沿用 GAP §五：门禁（node --check + typecheck + 单测）→ 对照原客户端对应 .py 逐项行为验收 → 打包产物验证 → IRON-09 提交。

# 七、差异统计总表

| 区 | ✅ 对齐 | 🟡 部分对齐 | ❌ 缺失 | 🔶 走样 | 小计 |
|---|---|---|---|---|---|
| 一、工作台 | 1 | 1 | 9 | 2 | 13 |
| 二、浏览器 | 6 | 1 | 4 | 2 | 13 |
| 三、媒体工具 | 1 | 5 | 1 | 3 | 10 |
| 四、系统配置 | 4 | 1 | 4 | 1 | 10 |
| **合计** | **12** | **8** | **18** | **8** | **46** |

\* 工作台 W12（定时任务管理）为 P1 已闭环条目，计入对齐口径。

## P1 级差距 Top 清单（仅移植对齐线，按业务影响排序）

1. **W1+W2+W3 工作台 AI 对话真实链路**（缺失）：核心入口完全 mock——/agent/chat、/llm/chat/completions、模型下拉、服务端会话续接+素材池、转编排任务开关全部未接线。这是四大区移植的「门面业务」，也是其余页面由会话智能体承载这一裁决的**前提**（智能体不可用 ⇒ 被承载页面全部悬空）。
2. **M4 字幕/水印去除 quad 框选**（走样）：sub_areas 是服务端 VSR 处理区域的决定性入参，无框选=盲处理，产出质量不可控；另缺上传进度与主动取消。

> B12 自动上架执行引擎已移出本清单——按 2026-08-28 二次裁决归「新增需求线」（运营类），不参与移植线优先级排序，详见 §六。

---
*本文档基于 2026-08-28 两仓库代码实际状态核实生成；原客户端行号以 `D:\Project\TinTin_AI_Agent_Main\studio\gui` 与 `D:\Project\TinTin_AI_Agent_Main\apps\asset-browser` 当前工作区为准。只读调研，未改动任何业务代码。*
