# 参考视频下载移植需求文档（OpenCreator video-download）

> 来源：GitHub justTinTin/OpenCreator（master），本地 `D:\Project\OpenCreator`。
> 性质：需求梳理 + 现状合理性评估，**未实施**。文档口径与《封面生成移植需求文档_OpenCreator_2026-09-07》一致。
> 日期：2026-09-07

---

## 〇、功能概述

「视频下载」是 OpenCreator 工作台的独立工具：粘贴**公开的 YouTube / Bilibili 视频链接** → 两步向导（添加链接 → 选择并下载）→ probe 解析真实规格 → 按档位下载 MP4 视频（自动合并音轨）或提取 MP3 音频 → 产物存入项目（含 sha256/时长/编码元数据），支持项目文件 tab 预览与保存到本机。

**核心结论（回答「YouTube 是否需要单独实现」）：不需要。** OpenCreator 用 **yt-dlp 单引擎统一承载**全部平台，YouTube 只是 ①URL 白名单条目 ②平台标签判定 ③yt-dlp 组件版本管理（YouTube 改版频繁 → extractor 需可更新）。没有任何 per-platform 下载代码。

## 一、源码结构（读毕清单）

| 文件 | 行数 | 职责 |
|---|---|---|
| `apps/web/src/features/dashboard/VideoDownloadWorkspace.tsx` | 1594 | 界面源：两步向导 + 三 tab + 更新建议条 + 错误文案映射 |
| `apps/daemon/src/creator/templates/video-download.ts` | 93 | 模板 v1(legacy)/v2 zod schema 与阶段编排 |
| `apps/daemon/src/creator/download/executor.ts` | 1001 | 行为源核心：probe/download/归一化/进度/错误分类/白名单 |
| `apps/daemon/src/creator/download/probe-parser.ts` | 202 | yt-dlp JSON → DownloadProbe + 档位(options)生成 |
| `apps/daemon/src/creator/yt-dlp/runtime.ts` | 90 | yt-dlp 三种运行形态（standalone exe / python 脚本+证书 / legacy） |
| `apps/daemon/src/creator/yt-dlp/update-manager.ts` | 614 | GitHub nightly 版本管理：检查/下载/sha256 校验/回退 |
| `apps/daemon/src/creator/yt-dlp/args.ts` | 5 | `--proxy` 注入 |
| `apps/daemon/src/api/routes.creator-runtime.ts` | — | `GET /creator/yt-dlp/status` |

## 二、界面逐控件对照（文案逐字）

**Step0 添加链接**：步骤条 `添加链接 / 选择并下载`（第 2 步 probe 前禁用）；面板标题 `公开视频链接`，说明 `当前支持 YouTube 和 Bilibili 单个公开视频`；URL 输入框（placeholder `粘贴视频链接`，aria `待下载视频链接`）+ 按钮 `解析链接`（进行中 `正在解析`）。

**Step1 结果区**（三 tab）：
- **视频信息**：缩略图（probe.thumbnailUrl，无则占位图标）+ 平台标签（YouTube/Bilibili）+ 标题 + `上传者 · 时长 · 分辨率`；按钮 `更换链接`
- **下载规格**：分段切换 `MP4 视频 / MP3 音频`（legacy 任务无 MP3）；档位单选列表——视频档按分辨率去重（label `720p`/`原始画质`，detail `MP4 · 1920 x 1080 · 30 FPS · 估计大小`），音频档固定 `320/192/128 kbps` 三档；首档标 `推荐`；每档独立下载按钮（状态机 `下载/排队中/下载中/转换中/已完成✓`）
- **项目文件**：历史行（图标按状态：排队钟/旋转/成功√/失败×/中断！）+ 标题 `{视频标题} · {档位}` + 描述（阶段文案 `正在准备下载/正在合并音视频/正在提取 MP3 音频/正在转换为本机兼容格式/正在检查下载文件`）；行内进度条（ preparing 不定态）；产物行按钮 `预览视频/播放音频`（blob 内嵌 video/audio）+ `保存到本机`（blob + a[download]，object URL 同源故可行）
- **上下文摘要卡**：`视频链接 / 来源平台 / 可用规格 / 当前选择 / 项目文件`

**yt-dlp 更新建议条**（errorCode=yt_dlp_update_recommended 时出现）：`视频平台规则可能已变化` + `建议更新解析器后重新执行刚才的任务` + 按钮 `更新并重试`（成功文案 `yt-dlp 已更新到 {ver}，任务已重新提交` / `yt-dlp 已是最新版本，任务已重新提交`）+ `前往第三方组件`；更新失败文案 4 条（下载失败/校验失败/存储失败/检查失败）。

**错误码 → 中文文案映射（12 条）**：unsupported_source→`当前仅支持 YouTube 和 Bilibili 公公开视频`；download_probe_stale→`链接已变化，请重新解析后再下载`；排队重复→`该规格已在下载队列中`/`该规格已经下载完成`；login_required→`该视频需要登录后访问，当前无法下载`；region_or_copyright_restricted→`该视频受地区或版权限制，当前无法下载`；disk_full→`磁盘空间不足，无法保存下载文件`；download_playback_conversion_failed→`视频兼容格式转换失败，请重新下载或选择其他清晰度`；network_unavailable→`无法连接视频平台，请检查网络或代理设置后重试`；yt_dlp_update_recommended→`视频平台规则可能已变化，请更新 yt-dlp 后重试`。

## 三、行为链路

### 3.1 阶段编排（模板 v2）
`probe`（executes download executor，产物 download_probe，resultVersionPolicy=none 不产生版本）→ `download`（dependsOn probe，输入取 latest-completed 的 download_probe，产物 source_video/source_audio）。action：update-settings / run-stage / undo-action。agentGuidance：`仅支持公开的 YouTube 和 Bilibili 链接。先运行 probe，再从 download_probe.options 中选择 option.id。更新 selectedOptionId 和 mediaType 后运行 download；不得自行构造或写入 formatId。`

### 3.2 probe
白名单校验（`https:` + host ∈ {youtu.be, youtube.com, *.youtube.com, b23.tv, bilibili.com, *.bilibili.com}，不通过报 unsupported_source）→ 读配置代理 → `yt-dlp --dump-single-json --no-playlist [--proxy ...] <url>` → zod 宽容解析（passthrough；formats 字段全 nullish）→ platform = extractor_key 含 bilibili ? 'bilibili' : 'youtube' → probe.json 落盘 + 进度（`Reading video information and available formats`）。

### 3.3 档位（options）生成——纯函数，核心资产
- 视频档：有视频流的格式按 `宽x高` 去重取最优（排序权重：高>宽>h264>mp4>有音轨>码率>大小），每档 id=`video-{height}-{n}`；无音轨的档自动搭配最佳纯音轨 audioFormatId；估算大小 = filesize || duration×bitrate
- 音频档：最佳纯音轨（m4a/mp4 优先）→ 固定 320/192/128 三档 MP3 转码档，id=`audio-mp3-{kbps}`，估算大小 = duration×kbps×1000/8

### 3.4 download（v2 按档位）
readProbe → **download_probe_stale 校验**（当前 URL ≠ probe.requestedUrl 则拒绝）→ 校验 optionId 在最新 probe.options 内且 mediaType 匹配 → 参数：
- 视频：`--no-playlist --newline --windows-filenames --ffmpeg-location <ff> --print after_move:filepath --progress --progress-delta 0.5 -f {videoFormat}+{audioFormat} --merge-output-format mp4 --remux-video mp4 -o OpenCreator-%(title).120B-%(id)s.%(ext)s`
- 音频：同骨架 + `-f {audioFormatId} --extract-audio --audio-format mp3 --audio-quality {kbps}K`
- 输出路径用 `--print after_move:filepath` 从 stdout 取（不猜文件名）

### 3.5 进度解析
`[download] {pct}%` 逐行解析；音视频两 part 按估算字节加权合成（observedBytes 实时修正权重），映射到 2–95%；`[Merger|VideoRemuxer]`→96% `正在合并音视频`；`[ExtractAudio|AudioConvertor]`→96% `正在提取 MP3 音频`；ffmpeg 归一化用 `-progress pipe:2` 解析 `out_time=` 映射 98–99%。

### 3.6 播放兼容归一化（下载后保证浏览器可播）
ffprobe 检查 vcodec∈{h264,avc1*,avc3*} 且 pix_fmt∈{yuv420p,yuvj420p} 且（无音轨或 aac/mp4a*）→ 满足则原样；不满足 → ffmpeg 转 `.playable.mp4`（h264+yuv420p 时 `-c:v copy`，否则 libx264 crf20 preset fast + `-pix_fmt yuv420p -tag:v avc1`；音频 copy 或 aac 192k；`-movflags +faststart`）；转后复检仍不兼容报 download_playback_conversion_failed；成功后删原文件。失败回滚删产物。

### 3.7 产物登记与安全
metadata：ffprobe 尺寸/时长/编码 + size/bytes + sha256（流式）+ mimeType + `source:'video-download'` + sourceUrl/requestedUrl/platform/sourceId/title/uploader/thumbnailUrl/optionId/mediaType/container/选中档位参数/playbackCompatible/normalizedForPlayback。安全：`safeOutputPath` realpath 校验输出不逃逸 workdir（download_output_escape）；`--windows-filenames`；标题截断 120B。

### 3.8 错误分类（stderr → 6 类错误码）
network_unavailable（timeout/unreachable/refused/DNS）/ format_unavailable / login_required（sign in/login/cookies）/ region_or_copyright_restricted（copyright/geo）/ **yt_dlp_update_recommended**（please update/nsig extraction failed/unable to extract/extractor error）/ disk_full / download_failed（原文尾 2000 字符）。

### 3.9 yt-dlp 组件管理（YouTube 的真正「单独」部分）
- 运行形态三选一：外部配置路径（version='external'）/ manifest standalone exe / **python 模式**（`python -I -B yt-dlp脚本` + SSL_CERT_FILE 证书 bundle）——更新管理器仅支持 python 模式
- 更新管理器：GitHub `yt-dlp/yt-dlp-nightly-builds` releases/latest（20s 超时、2MB 响应上限、版本正文校验）；下载 120s 超时、**16MB 上限、sha256 校验、重定向主机白名单**（api.github.com/github.com/objects.githubusercontent.com/release-assets.githubusercontent.com）；版本目录落盘 + state.json；启动时校验 active 版本 hash 不符即回退 bundled；**每 7 天检查、不自动安装**（status 端点暴露 checkDue/updateAvailable）
- 失败恢复闭环：错误分类报 yt_dlp_update_recommended → UI 出建议条 → 「更新并重试」= update() + 重提同 optionId 的 download 阶段

### 3.10 UI 状态合并与恢复
probe 工件按 `requestedUrl === 当前输入` 匹配（URL 变了旧 probe 不显示）；已下载档位集合 = 产物 metadata.optionId（按 URL 或 sourceArtifactIds 归属）；多档位并行下载用 submission tail 串行提交；取消/恢复走 job 级 cancel/resume；canceled/interrupted 阶段可从「项目文件」重提。

## 四、现状实现合理性评估（结论：架构合理，可作移植蓝本）

**合理且值得照搬的 7 点**：
1. **yt-dlp 单引擎 + URL 白名单**——extractor 维护外包给上游，YouTube 改版只需升级 yt-dlp，客户端零代码改动；白名单收敛攻击面
2. **probe→download 两阶段 + stale 校验**——格式 ID 时效性强，先解析后下载、URL 变更强制重解析，杜绝拿过期 formatId 下载失败
3. **档位（options）抽象**——UI 只见「720p/MP3 192kbps」，裸 formatId 不出纯函数层；agentGuidance 明确禁止自造 formatId
4. **播放兼容归一化**——下载产物保证 h264/aac/yuv420p+faststart，浏览器/Electron 内嵌播放必然可播；转后删原件控盘
5. **进度合成精细**——双 part 字节加权 + observedBytes 修正，比「假进度」体验好一个档次
6. **安全细节扎实**——realpath 防目录逃逸、更新器 sha256+重定向白名单+大小上限、不自动装更新
7. **错误分类→文案→恢复动作闭环**——尤其 yt_dlp_update_recommended 的「更新并重试」一键恢复

**局限 / 与本端场景的错配（5 点）**：
1. **平台面窄**：仅 YouTube/Bilibili；本端用户主场景是国内平台（抖音/快手/小红书/视频号），本端已有 extractors/（douyin/kuaishou/bilibili/weixin/xiaohongshu）+ 嗅探下载体系——移植时应是**并存**（yt-dlp 管公开链接，extractor 管登录态平台）而非替换
2. **执行位置**：OpenCreator 在本地 daemon 跑 yt-dlp；本端架构是「服务端算力」，YouTube 下载放客户端（Windows 本地 + 用户代理）还是服务端（Linux 出海网络）需裁决
3. 「保存到本机」用 blob+a[download]：大文件全量进内存；本端 Electron 有 saveFile 对话框+主进程下载的既定规范，移植时应替换
4. MP3 仅三档转码，无原始 m4a 直下档位
5. probe 缩略图为外链直连（需能访问 YouTube CDN）

## 五、移植落点（建议）

| OpenCreator 概念 | 本端落点 |
|---|---|
| daemon download executor | `main/` 新增 `ytdlp-gate.js`（对齐 ffmpeg-gate 模式：spawn yt-dlp.exe + IPC，主进程只做 I/O 不做策略） |
| yt-dlp 组件管理 | 复用 `model-manager.js` 的 CDN 下载/SHA256 校验骨架，或裁剪版 update-manager；资源放 userData |
| 模板/阶段编排 | **不搬**（本端无 Creator 框架）；以「纯函数层 ytdlp-logic.js（参数拼装/进度解析/错误分类/档位生成）+ main IPC + 渲染层 VideoDownload.vue」复刻（对齐 montage-voice-ipc 先例） |
| 白名单/平台标签 | 纯函数照搬（host 白名单 + extractor_key 判定） |
| 播放兼容归一化 | ffmpeg-gate 已有 probe/转码原语，补 codec 判定纯函数 |
| 「保存到本机」 | 按本端规范改 `dialog.saveFile` + 主进程下载通道 |
| 与现有下载体系关系 | 并存：`media-downloader.js`（嗅探/extractor）不动，新增 yt-dlp 通道；B 站公开视频两边都可到，默认路由需裁决 |

## 六、契约缺口上报（铁律）

1. **服务端 openapi（464 端点）无 yt-dlp/视频元数据类端点**——若走「客户端集成 yt-dlp」方案则此缺口不阻断（纯本地能力，与封面生成不同）；若走「服务端代理」方案需新增端点。**此为方案裁决点**。
2. 若服务端方案：需 `POST /video/probe`（元数据+档位）、`GET /video/download`（进度轮询或 SSE）两类端点 + 服务端部署 yt-dlp 与代理出口。
3. 无既有契约可复用：`/prompt/image`（反推）、`/material/*`、extractor 相关端点均不含 URL→规格解析能力。

## 七、实施拆解建议（客户端方案口径）

- **D1 纯函数层 + 单测**：白名单/平台判定、yt-dlp 参数拼装（probe/video/audio/legacy）、进度行解析（percent/bytes/phase）、档位生成、错误分类——全部纯函数，node --test 覆盖
- **D2 主进程**：ytdlp-gate.js（yt-dlp 路径解析、spawn、行解析回传、realpath 防逃逸、归一化转码）+ preload/类型
- **D3 渲染层**：VideoDownload.vue 两步向导 + 三 tab（对照第二节逐字文案）+ useVideoDownload.ts
- **D4 收尾**：门禁三件套（vue-tsc/vite build/node --test）+ node --check 主进程文件

## 八、待裁决清单

1. **执行位置**：客户端集成 yt-dlp.exe（推荐，同 ffmpeg 先例、零契约缺口）vs 服务端代理（需补端点+服务端出海网络）
2. **yt-dlp 二进制来源**：打包内置（bundled，跟随版本）vs 首启下载+版本管理（managed，对齐 OpenCreator nightly 模式）vs 两者兼有
3. **平台范围**：首版是否只做 YouTube+Bilibili（对齐源实现）？国内平台继续走既有 extractor 体系？
4. **代理配置**：复用系统设置页的代理配置项还是 yt-dlp 独立配置？（OpenCreator 是全局 services.proxy）
5. **产物去向**：存入哪个目录（montage_cache？下载目录？还是接素材库上传）？是否联动「仿爆款」/混剪素材流程
6. **MP3 档位**：保留 320/192/128 三档还是补原始音轨直下？
