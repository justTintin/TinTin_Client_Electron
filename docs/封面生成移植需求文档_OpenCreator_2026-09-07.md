# 「封面生成（Cover Generator）」移植需求文档（2026-09-07）

> 需求来源：GitHub `justTinTin/OpenCreator`（master），本地已克隆至 `D:\Project\OpenCreator`。
> 功能定位：结合 **主题提示词 / 参考图 / YouTube 视频链接** 生成多版（1-4 张）可直接发布的视频封面，支持对比选择、逐张下载、版本管理。
> 源码结构对照：`apps/web`（React 界面源）+ `apps/daemon`（Node 行为源）。
> 采用**双源一比一移植方法论**：界面源逐控件对照、行为源逐调用链复刻、文案逐字。
> **当前状态：需求梳理完成，待裁决立项**。存在 **2 项服务端契约缺口**（见「六、契约缺口上报」），不补齐无法端到端落地。

---

## 〇、功能概述

三步向导：**① 生成依据**（提示词 + 参考图上传 + YouTube 链接选填）→ **② 封面设置**（风格 / 文字语言 / 主副标题 / 比例 / 数量 / 质量）→ **③ 封面方案**（多候选结果网格 + 参考素材 + 任务设置 + 版本管理）。

**两种生成链路**：
- **提示词模式**：用户 prompt（+可选参考图）→ 一次图像生成调用产出 N 张候选。
- **YouTube 模式**：填入 YouTube 链接 → `analyze-source` 阶段（yt-dlp 取元数据 → LLM 生成封面文案 brief → 下载原封面作参考图）→ 成功后**自动续跑** `generate` 阶段。原封面仅作视觉参考，最终文字与画面由图像模型按固定风格模板一次性生成。

**核心产出物**：`cover_image` 工件（N 张/版本），带完整元数据（provider/model/candidate/ratio/headline/subheadline/style/language/参考图来源）；可下载、可管理多版本（resultSnapshots V1/V2…）。

---

## 一、OpenCreator 源码结构（行为源清单）

| 层 | 文件 | 职责 |
|---|---|---|
| 模板定义 | `apps/daemon/src/creator/templates/cover.ts` | cover 模板 v2：zod inputSchema（sourceType/sourceUrl/prompt/coverStyle/coverTextLanguage/customStylePrompt/coverHeadline/coverSubheadline/ratio/candidateCount/quality/provider/referenceImageArtifactId…）、两阶段（analyze-source → generate）、产物类型 |
| 工作流编排 | `apps/daemon/src/creator/templates/cover-actions.ts` | 阶段校验、LLM/图像配置缺失 → needs_input 深链设置页、YouTube 分析成功自动续跑 generate、崩溃恢复 recover / 配置后自动续跑 resumeConfiguredJobs |
| 分析执行器 | `apps/daemon/src/creator/cover/executor.ts` | analyze-source：yt-dlp `--dump-single-json` → brief 生成 → 缩略图下载（20MB 上限、magic 校验）；yt-dlp stderr 错误分类（login_required/private/network_unavailable/region_or_copyright/需升级） |
| 文案生成 | `apps/daemon/src/creator/cover/analyzer.ts` | LLM chat/completions（response_format=json_object）生成 brief `{title,summary,headline,subheadline,emphasisTerms[≤3],language}`，zod strict 校验 |
| 风格库 | `apps/daemon/src/creator/cover/styles.ts` | 4 预设风格 instructions（英文原文，一比一保留）+ custom 包装 + 语言标签映射 |
| 图像执行器 | `apps/daemon/src/creator/image/executor.ts` | generate：**封面 prompt 组装**（coverGenerationPrompt）→ 多候选 `Promise.allSettled` 并发 → ffmpeg 归一化裁剪到目标比例 → 部分失败容忍（partial_success + failures） |
| 图像提供商 | `apps/daemon/src/image-generation/provider.ts` | openai/jimeng（/images/generations JSON、/images/edits multipart）、gemini（generateContent inlineData）、kling（task 提交 + 1.5s 轮询）；b64_json/url 双响应；180s 超时；30MB 图 / 120MB 响应上限 |
| 参考图上传 | `apps/daemon/src/creator/reference-image-upload.ts` | 20MB 上限、png/jpeg/webp magic 校验、sha256 去重、revision 乐观锁（409）、流式落盘 |
| 项目封面 | `apps/daemon/src/creator/project-cover.ts` | resolve：最新版本 cover_image 第一候选 → generated_image → **视频抽帧兜底**（ffmpeg 5s 失败退 0s，960 宽，缓存 `project-cover-{sha256_16}.jpg`，并发去重） |
| 界面 | `apps/web/src/features/dashboard/CoverGeneratorWorkspace.tsx`（1412 行） | 三步向导全量 UI、结果三 tab、版本菜单、终止/继续、错误码→中文文案映射 |
| 集成测试 | `apps/daemon/test/integration/creator-cover-generation.test.ts` | 端到端行为基线：生成 2 候选 → 上传参考图 → 再生成（fetch 全部走 /images/edits）→ 最新版本第一候选即项目封面 |

---

## 二、界面逐控件对照（界面源 `CoverGeneratorWorkspace.tsx`）

外层 `CreatorToolShell`：标题「封面生成」+ 副标题「从提示词、参考图或 YouTube 内容生成真实封面」+ 上下文栏（`V{n} · {m} 个方案 · {ratio}` / `正在处理 {percent}%` / `等待生成 · {ratio} · {n} 个方案`）。OpenCreator 版还挂 Agent 共创面板（**TinTin 无对应设施，见待裁决**）。

### Step 0「生成依据」（currentStep=0）

| # | 控件 | 规格 / 文案（逐字） |
|---|---|---|
| 1 | 面板标题/说明 | 「生成依据」/「使用 YouTube 链接时会自动参考原封面，上传参考图后优先使用上传图片」 |
| 2 | 参考图上传块 | accept `image/png,image/jpeg,image/webp`；空态「添加参考图」，有图「更换参考图」+ 移除按钮；上传/已归档均出缩略预览（objectURL） |
| 3 | 内容与补充要求 textarea | rows=7、maxLength=4000，占位「补充需要突出的内容、主体或排版要求」 |
| 4 | 示例提示词按钮 | 「填入示例提示词」→ 填入「突出原封面的核心主体，封面文字直接有力，整体适合视频平台缩略图」 |
| 5 | YouTube 链接（选填） | 「YouTube 链接 选填」，占位「分析视频内容并参考 YouTube 原封面生成」；**非空即切 sourceType=youtube** |
| 6 | 底部「继续」 | 校验失败文案：「请填写封面内容要求或有效的 YouTube 链接」 |

### Step 1「封面设置」（currentStep=1）

| # | 控件 | 规格 / 文案（逐字） |
|---|---|---|
| 7 | 面板标题/说明 | 「封面设置」/「每次生成 {n} 个真实候选方案」 |
| 8 | 封面风格（radio 5 选） | 个人成长 / 心理学 / 财富 / B站风格（默认）/ 自定义，带三色 swatch |
| 9 | 自定义风格说明（选风格=自定义时出现） | textarea rows=3、maxLength=1000，占位「描述配色、字体气质、构图和视觉层级」；提交校验「请填写自定义风格说明」 |
| 10 | 封面文字语言（select） | 简体中文 / 繁體中文 / English / 日本語 / 한국어（默认跟随应用语言，值域 zh-CN/zh-TW/en-US/ja-JP/ko-KR） |
| 11 | 主标题（选填） | maxLength=80；YouTube 模式占位「留空时根据视频标题和描述生成」、提示词模式「需要出现在封面上的主标题」 |
| 12 | 副标题（选填） | maxLength=140，占位「需要出现在封面上的补充文字」 |
| 13 | 封面比例（segmented） | 16:9（默认）/ 1:1 / 9:16 |
| 14 | 生成数量（segmented） | 1/2/3/4 张（默认 2） |
| 15 | 生成质量（segmented） | 快速(low) / 标准(medium，默认) / 高清(high) |
| 16 | 底部主按钮 | 无结果「开始生成」/ 有结果「生成新版本」；提交中「正在启动...」 |

### Step 2「封面方案」（currentStep=2，workspacePhase=result）

| # | 控件 | 规格 / 文案（逐字） |
|---|---|---|
| 17 | 结果三 tab | 「封面方案」（Images 图标）/「参考素材」（ImagePlus）/「任务设置」（Settings2）；右侧版本下拉（V1/V2…，描述「生成封面」） |
| 18 | 方案网格 | 按 candidate 序排布；卡片=预览图 + 「方案 {n}」+ 下载按钮；加载态「正在加载预览」；标题行附注：参考原封面→「V{n} · 已参考 YouTube 原封面」、参考上传图→「V{n} · 已参考上传图片」、否则「V{n}，选择、下载或继续调整」 |
| 19 | 下载 | 文件名 `OpenCreator-cover-V{version}-{candidate}.{png\|jpg\|webp}`（有 metadata.fileName 用原名）；成功通知「封面方案 {n} 已开始下载」 |
| 20 | 空态/进度 | 生成中显示阶段标签（「正在分析 YouTube 视频内容」/「正在生成封面方案」）+ 进度条（percent 或 indeterminate）+ 「任务正在后台处理 已完成 {c}/{t}」 |
| 21 | 参考素材 tab | YouTube 来源行（链接）、视频缩略图行（「已用于本版本生成」/「仅作为来源素材保存」）、参考图行（「已用于本版本生成」/「未用于本版本生成」）、空态「当前版本没有参考素材」/「封面仅根据提示词生成」 |
| 22 | 任务设置 tab | 快照回显 dl：封面比例/生成数量/生成质量/封面风格/文字语言/实际参考（「YouTube 原封面」或文件名或「未使用」）/主标题/副标题/补充要求（「根据视频内容生成」兜底） |
| 23 | 底部动作区 | 返回 / 「返回 V{n} 方案」/ 终止任务（danger，「正在终止...」）/ 继续任务（可恢复中断，「正在继续...」）/ 调整设置 |
| 24 | 运行提示条 | notice/error/needsInput 三合一；needsInput 深链「打开 AI 服务设置」 |

### 全局状态与草稿持久化

currentStep/furthestStep/workspacePhase/resultTab/draftBaseVersion 及全部输入随会话草稿持久化（刷新/切页恢复）；有结果时自动跳 Step2 并定位最新版本。

---

## 三、行为链路（一比一复刻要点）

### 3.1 阶段编排（cover-actions.ts）

1. **analyze-source 前置校验**：sourceUrl 必须为 youtube.com/youtu.be（否则 `unsupported_source`）；LLM apiKey 缺失 → needs_input（`creator_llm_config_missing`，深链设置→文本模型，resumeStageId=analyze-source）。
2. **generate 前置校验**：三选一输入（prompt / coverHeadline / 已完成 cover_brief）否则 `creator_stage_input_missing`；图像凭证缺失 → needs_input（`creator_image_config_missing`，section=image）；**有参考图但 provider 不支持 → `unsupported_capability`**（「当前图像服务不支持参考图，请切换到 OpenAI 或 Gemini」）。
3. **自动续跑链**：analyze-source 成功（workflow=true）→ 自动派发 generate（幂等键 `cover:{parentStageRunId}:generate`）；YouTube 模式取不到原封面 → needs_input（`creator_cover_reference_missing`：「无法获取 YouTube 原封面，请重新分析视频来源」）。
4. **恢复**：daemon 重启后 recover() 扫描已成功分析的任务续跑；needs_input 任务配置就绪后 resumeConfiguredJobs() 自动重放。

### 3.2 analyze-source 执行（cover/executor.ts）

1. yt-dlp `--dump-single-json --no-playlist {url}`（含代理注入、stderr 重试行解析→progress `reading_source_retry {attempt}/{total}`）；元数据取 id/title/description/uploader/duration/thumbnail/tags。
2. LLM（json_object 模式）生成 brief。**系统提示词逐字保留**（关键约束）：不设计画面/人物/构图；所有封面文字必须使用指定语言；主标题简中 6-16 汉字/英文 3-8 词；用户指定主副标题必须**逐字保留**；不得虚构标题描述外事实；emphasisTerms ≤3。
3. brief zod strict 校验后与来源信息落 `cover-brief.json` 工件（metadata 含 summary/headline/subheadline/emphasisTerms/language）。
4. 无 thumbnail → `creator_cover_reference_missing`；有则下载（http/https、20MB、magic 判 png/jpeg/webp）落 `source-thumbnail.{ext}` 工件（role=platform-thumbnail）。
5. 进度相 位：reading_source → analyzing_source(45) → downloading_thumbnail(75) → completed(100)。

### 3.3 generate 执行（image/executor.ts）——封面 prompt 组装（核心）

`coverGenerationPrompt` 按段拼接（**模板语句逐字保留**，英文）：
1. 总纲：一次出图即成品（含全部文字），不得只出背景或分层排版。
2. REFERENCE IMAGE 三态指令：`source_keyframe`（保留原封面可识别主体/物体/关联，可重设计版式/光影/配色/字体，不得替换为无关内容）/ `reference_image`（以用户图为主体与构图参考）/ 无参考（不得添加无依据内容）。
3. EXACT COVER TEXT（有 headline）：`Language: {Simplified Chinese}(zh-CN)` + `Headline: "{headline}"`（JSON 序列化防注入）+ 可选 `Subheadline` + 可选 `Visually emphasize these exact terms when they appear: {emphasisTerms}`；**Do not translate, rewrite, omit, misspell, duplicate, or add any other visible words.**；无 headline 时仅约束语言与「只加有内容依据的文字」。
4. SELECTED VISUAL STYLE：风格 instructions（见 §3.5）或 custom 包装。
5. COMPOSITION AND OUTPUT：headline 第一视觉优先、缩略图小尺寸可读、正文避开主体、headline 最多两行、副标题次级、整图一体。
6. 追加「ADDITIONAL USER REQUIREMENTS: {userPrompt}」（可选）。

### 3.4 候选生成 / 归一化 / 容错

- **尺寸映射**：16:9→生成 1536x1024 → ffmpeg `scale=1536:864:force_original_aspect_ratio=increase,crop=1536:864` 归一；9:16→1024x1536→864x1536；1:1→1024x1024（不归一）。中间源文件 `-source.{ext}` 生成后删除。
- **并发**：N 个候选各自独立调 provider（count=1），`Promise.allSettled`；全败 → 抛首个错误；部分败 → 阶段 `partial_success`，progress 带 `{completed, failed, total, failures[{candidate,message}]}`；percent = 10 + 85×(完成+失败)/总数。
- **产物 metadata**：provider/model/candidate/imageSize/quality/mimeType/fileName/referenceArtifactId(+Kind)/coverStyle/coverTextLanguage/headline/subheadline/emphasisTerms/ratio/normalizedToRatio/width/height。
- **错误归一**：config_missing→`creator_image_config_missing`、unsupported_capability 透传、Abort→`creator_stage_canceled`、其余→`image_generation_failed`。

### 3.5 风格库（styles.ts，逐字英文 instructions 保留）

| id | 展示名 | 色彩/字体要点 |
|---|---|---|
| personal-growth | 个人成长 | 深navy+暖金+亮白；重点短语暖金强调；向上感 |
| psychology | 心理学 | 深绿+蓝灰+白+少量珊瑚点缀；克制、可信 |
| wealth-platinum-red | 财富 | 白+铂金+炭灰+强红点缀；数字/金融词红色强调；无依据不添加钱/奢侈品/图表 |
| bilibili-red-blue-white（默认） | B站风格 | 红+亮蓝+白+深描边；粗体集成排版、小字号可读；色块+字型制造能量 |
| custom | 自定义 | 用户说明仅作视觉风格；保留参考主体、逐字渲染指定文字；空说明兜底「polished, high-contrast editorial video thumbnail」 |

### 3.6 参考图上传（reference-image-upload.ts）

`POST /creator/jobs/{id}/reference-image?expectedRevision=&fileName=&mime=&lastModified=`，Content-Type `application/vnd.opencreator.creator-reference-image`，body 原始流。约束：≤20MB（413）、非空（400）、png/jpeg/webp magic（415）、sha256 去重（同哈希复用已有 artifact 并删临时文件）、revision 不符 409。产物 kind=`reference_image`，metadata `{fileName, source:'local-upload', size, sha256, lastModified, format}`。

### 3.7 项目封面解析（project-cover.ts，跨模板复用）

优先级：最新结果版本的 `cover_image` 第一候选（按 resultVersion→candidate→createdAt→id）→ 最新 `generated_image` → **视频类工件抽帧兜底**（ffmpeg `-ss 5` 失败退 `-ss 0`，`scale=960:-2` `-q:v 3`，30s 超时，落 `previews/project-cover-{sha256(videoId)前16}.jpg` 缓存，Promise 并发去重）。

### 3.8 图像上游契约（image-generation/provider.ts）

| provider | 端点 | 请求 | 响应取图 |
|---|---|---|---|
| openai（默认模型 gpt-image-1） | `{base}/images/generations`（无参考，JSON）/`{base}/images/edits`（有参考，multipart：model/prompt/size/quality/n + image） | JSON `{model,prompt,size,quality,n}`；quality 仅 openai 传 | `data[].b64_json` 或 `data[].url`（同源 url 带 Authorization 下载） |
| jimeng（豆包 doubao-seedream-4-0-250828） | 同上，quality 不传 | | 同上 |
| gemini（gemini-2.5-flash-image） | `models/{model}:generateContent` | contents.parts=[inlineData?(参考图), text]；generationConfig.responseModalities=[TEXT,IMAGE].imageConfig.aspectRatio（3:2/2:3/1:1） | candidates[].content.parts[].inlineData |
| kling（kling-v2-1） | `v1/images/generations`（JWT 签名头）→ `GET …/{task_id}` 轮询 1.5s | `{model_name,prompt,aspect_ratio,n}` | `data.task_result.images[]`（b64/url） |

统一：180s 超时；单图 30MB / 响应 120MB 上限；**支持参考图的仅 openai/gemini**。

---

## 四、错误码 → 文案映射（UI 逐字）

| 错误码 | 中文文案 | 深链 |
|---|---|---|
| creator_image_config_missing | 请先配置图像生成服务 | 设置→图像服务 |
| creator_llm_config_missing | 使用 YouTube 来源前，请先配置文本模型 | 设置→文本模型 |
| unsupported_capability | 当前图像服务不支持参考图，请切换到 OpenAI 或 Gemini | — |
| creator_cover_reference_missing | 无法获取 YouTube 原封面，请重新分析视频来源 | — |
| unsupported_source | 目前仅支持公开的 YouTube 链接 | — |
| network_unavailable | 无法连接 YouTube，请检查网络或代理设置后重试 | — |
| image_generation_failed | 封面生成失败，请检查图像服务和网络后重试 | — |
| creator_stage_canceled | 封面生成任务已终止 | — |
| 兜底 | 封面生成失败，请稍后重试 | — |

yt-dlp stderr 分类：`sign in/login`→login_required；`private video`→source_private；网络类→network_unavailable；`copyright/not available`→region_or_copyright_restricted；`please update/extractor error` 等→yt_dlp_update_recommended；兜底 cover_source_analysis_failed。

---

## 五、移植到 TinTin_Client_Electron 的落点

| OpenCreator 设施 | TinTin 对应 | 说明 |
|---|---|---|
| CoverGeneratorWorkspace（React 三步向导） | 媒体工具·图片组新工具页 `CoverGenerator.vue`（组合式 `useCoverGen.ts`） | 与 ViralClone/ImageMatting 同组接入；三步向导结构可对照 M9 先例 |
| 模板/阶段/工件/needs_input（daemon CreatorService） | 本端无通用任务编排框架 | **不搬框架**：以「纯函数层（cover-gen-logic）+ 主进程 IPC（cover-gen-ipc.js）+ 渲染层组合式」复刻两条链路，任务状态机收敛在 IPC 层（对齐 montage-voice-ipc 先例） |
| 封面 prompt 组装 / 风格库 / brief zod | 纯函数层 `cover-gen-logic.js` + 单测 | prompt 模板、风格 instructions、尺寸映射、错误分类均可纯函数化并固化单测（对齐 voice-tts-logic 先例） |
| ffmpeg 归一化裁剪 / 视频抽帧 | montage-proxy-ipc.js 既有 runFfmpeg 模式 | 复用 getBinDir/getFfmpegPath/runFfmpeg |
| yt-dlp 元数据+缩略图 | **契约缺口 #2** | 本端服务端无 yt-dlp 代理端点；客户端直连 YouTube 受网络环境限制（见下） |
| LLM brief 生成 | `llmChat`（服务端 /llm/chat/completions） | 需验证服务端支持 response_format=json_object 透传 |
| 图像 provider 直连 | **契约缺口 #1** | 服务端 openapi（464 端点）无 OpenAI 兼容生图代理；仅有 /prompt/image（反推提示词）、/product-image/*（产品图管线）、/comfyui/* |
| 参考图上传 | 通用 `server.upload` multipart | 归档到任务目录（cacheDir/cover_gen/{jobId}/references） |
| 结果预览/下载 | file:/// + dialog:saveFile / downloadResult | 对齐 AudioGen/VSR 既有口径 |

---

## 六、服务端契约缺口上报（铁律：接口与文档不一致必须报出）

1. **图像生成端点缺失**：服务端 openapi-latest.json 无任何「文本→图像」生成端点（/images/generations 类）。OpenCreator 的生图是**客户端直连第三方 provider**（OpenAI/Gemini/即梦/可灵，凭证在客户端配置）。TinTin V3 架构下凭证应由服务端持有、推理收归服务端（对齐 LLM/TTS 先例）。**需要服务端新增生图代理端点**（建议 `POST /image/generations`，body `{prompt,size,quality,n,reference_image_b64?,provider?}`，响应 `{data:[{b64_json|url}]}`），或明确复用 /product-image/generate 管线的裁决。**未补齐前仅可做「提示词/文案链路」与纯函数层。**
2. **YouTube 元数据端点缺失**：analyze-source 依赖 yt-dlp 取标题/描述/tags/缩略图。服务端无等价端点（有 /douyin/parse、B 站抽取器，无 YouTube）。需服务端新增（如 `GET /video/metadata?url=`，返回 `{title,description,uploader,duration,thumbnail,tags}`），或裁决降级：**首版仅保留「提示词 + 参考图」模式**，YouTube 模式列入服务端就绪后启用。
3. 次要核对项：/llm/chat/completions 是否透传 `response_format:{type:'json_object'}`（brief 生成依赖严格 JSON 输出；不支持则需服务端补或客户端降级容错解析）。

---

## 七、实施拆解建议（对齐 PR#4 分批节奏）

| 批次 | 内容 | 依赖 |
|---|---|---|
| C1 纯函数层 | cover-gen-logic.js：封面 prompt 组装（逐字模板）、风格库、尺寸/归一化映射、错误分类映射、brief zod 等价校验、候选排序；单测 | 无 |
| C2 主进程 | cover-gen-ipc.js：generate 链路（llmChat 不需要；调服务端生图端点→落盘→ffmpeg 归一→元数据回写）、analyze-source（依赖缺口 #2）、参考图归档、任务/版本状态机（resultSnapshots 简化版：内存+磁盘 manifest） | 契约缺口 #1/#2 |
| C3 渲染层 | CoverGenerator.vue 三步向导逐控件 + useCoverGen.ts；MediaTools 接入 | C2 |
| C4 收尾 | 版本管理（生成新版本/返回 V{n}）、终止/继续、needs_input 映射设置页深链、门禁（vue-tsc + vite build + node --test） | C3 |

---

## 八、待裁决清单

1. **YouTube 模式是否首版纳入**（依赖缺口 #2；否则首版=提示词+参考图）。
2. **生图 provider 范围**：服务端代理落地后先接哪一家（建议 openai 兼容口径先行，jimeng/gemini/kling 后补）。
3. **Agent 共创面板**（CreatorToolShell 的 quickActions/Agent 检查设置/命令解析 handleCommand）：OpenCreator 核心交互之一，但 TinTin 无 CreatorCollaborationPanel 等价设施——是否映射到工作台 Agent 对话（Workbench chat）或首版裁掉。
4. **项目封面联动**：project-cover.ts 的「封面图替代视频抽帧作项目封面」逻辑在 TinTin 对应「任务/项目缩略图」体系（工作台任务列表），是否本期接入。
5. **生成数量上限**：模板 schema 为 1-4（UI 同），legacy v1 为 1-8、image-generation 模板 1-4——确认 TinTin 取 1-4。
6. **参考图上传入口**：沿用 OpenCreator「Step0 内嵌上传块」布局，还是对齐 TinTin 既有「先选文件再上传」模式。
