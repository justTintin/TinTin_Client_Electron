# TinTin AI Agent 部署与配置指南（客户端）

> **架构现状（2026-08-08）**：AI 推理统一由**服务端统一计算节点**（`compute_server_url`）执行，
> 包括：LLM、ASR 转写、VoxCPM 声音克隆、视觉分析、CLIP 向量、OCR、去字幕、混剪拼接、成片、ComfyUI 图像生成。
> **客户端（本机）只做**：UI 交互、媒体预处理（ffmpeg 提取音频/抽帧）、本地轻工具（剪映草稿导出、封面、即梦、直播切片）。
> 因此：客户端**不再需要本地 GPU 大显存、模型权重、数据库、本地模型服务**。

---

## 1. 系统要求（客户端）

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10/11 64位 |
| GPU | **可选**。默认无需（推理在服务端）；仅当使用本地轻量功能（如抠图 rembg、图层化生图、本地即梦）时需要 NVIDIA GPU |
| Python | 内置 `python_embeded`（3.11），无需单独安装 |
| 磁盘空间 | 客户端本体 + 素材产出（不含模型权重，约 10~20GB） |
| 网络 | 可达服务端统一计算节点；外网（模型下载、飞书、DeepSeek 等按需） |

> 旧版"本地跑模型"的显存/性能模式（Ollama 并发、CLIP 批大小）已由服务端承担，客户端无需配置。

---

## 2. 目录结构（客户端视角）

```
TinTin_AI_Agent_Main/
├── python_embeded/          # 主 Python 3.11 环境
├── studio/                  # 客户端主程序源码
│   ├── gui_main.py          # 启动入口
│   ├── gui/                 # 界面代码
│   ├── utils/               # 工具模块（远程服务客户端）
│   ├── config/              # 配置文件（见 §5）
│   ├── bin/win/             # 本地工具（ffmpeg、dreamina.exe 等）
│   ├── assets/              # 图标、字体、声音样本
│   ├── data/                # 运行时数据（自动生成）
│   └── .runtime/            # 日志、临时文件、cookies
└── apps/                    # 本地子应用（可精简；模型类由服务端提供）
    └── asset-browser/       # 素材浏览器（外部 Electron）
```

> **模型类子应用**（`voxcpm2`、`clip-models`、`whisper-models`、`PaddleOCR`、`rembg`、`comfyui`、`vsr-*`）**由服务端部署**，客户端不再依赖，可不在本机安装。

---

## 3. 启动方式

```bat
studio\run_gui_integrated.bat
```

该脚本自动定位 `python_embeded\pythonw.exe` 并启动 `gui_main.py`。

---

## 4. 外部工具（本地仍需要）

### ffmpeg / ffprobe
- `ffprobe.exe` 需放在工程根目录
- `ffmpeg.exe` 搜索顺序：`studio/bin/win/` → 系统 PATH → 工程根目录 → `apps/asset-browser/bin/` → `apps/vsr-v1.4.0/backend/ffmpeg/win_x64/`
- 客户端本地媒体预处理（抽帧、混音、封面、剪映导出）依赖；缺失时相关本地功能不可用

### Ollama / 模型服务
- 已由服务端统一计算节点承担，客户端**无需本地安装 Ollama 或拉取视觉模型**

---

## 5. 配置文件

> ⚠️ **含凭据的配置文件不入库**：下列 JSON/ini 含 API Key、密码等敏感信息，已从 git 移除（本地保留）。仓库提供 `.example` 模板（值用 `xxx` 占位），新部署时复制为正式文件并填入真实值。

### 5.1 `config.ini`（工程根目录）

飞书集成配置（仍需客户端配置）：

```ini
[Feishu]
appid = cli_xxx               ; 飞书应用 App ID
appsecret = xxx               ; 飞书应用 App Secret
apptoken = xxx                ; 飞书表格 App Token
tableid = tblxxx              ; 选题表格 Table ID
topicfield = 文案标题          ; 选题标题列字段名
scriptfield = 脚本             ; 脚本内容列字段名
foldertoken =                 ; 文件夹 Token（可空）
```

> **`[VoxCPM]` 段（modelpath/port）已废弃**：声音克隆走服务端 `/voxcpm/tts`，无需本地模型路径/端口。旧文件可保留但不再生效。
> 代码加载的是**工程根目录**的 `config.ini`，不是 `studio/config.ini`（后者为冗余备份）。模板见 `config.ini.example`。

### 5.2 `studio/config/ai_config.json`（核心：只需填统一计算节点地址）

| 字段 | 说明 | 必填 |
|------|------|------|
| `compute_server_url` | **统一计算节点地址**（LLM/ASR/VoxCPM/视觉/CLIP/OCR/素材/成片共用） | **必填** |
| `llm_model` | 文本模型名（服务端转发用） | 建议填 |
| `llm_vision_model` | 视觉模型名（如 `qwen2.5vl:7b-16k`） | 建议填 |
| `vox_mode` | VoxCPM 模式（固定 `api`） | 建议填 |
| `vox_timesteps` / `vox_cfg` | VoxCPM 推理参数（默认 20 / 2.0） | 否 |
| `runninghub_api_key` / `runninghub_base_url` | RunningHub 云端生图（按需） | 否 |
| `comfyui_addr` | ComfyUI 独立节点（如本地部署才填） | 否 |
| `llm_api_url` / `llm_api_key` | **通常由服务端代理，客户端可留空**；仅当直连第三方 LLM 时才填 | 否 |
| `whisper_api_url` / `vox_api_url` / `clip_api_url` / `llm_vision_api_url` / `material_api_url` / `ocr_api_url` | 各能力地址，**不填则自动从 `compute_server_url` 派生** | 否 |

> 架构说明：客户端所有 AI 请求统一发往 `compute_server_url`，由服务端代理各能力（LLM/ASR/TTS/视觉/CLIP/OCR/成片）。各地址可单独覆盖，不填自动派生。
> 模板见 `studio/config/ai_config.json.example`。

### 5.3 `studio/config/material_index_config.json`（素材检索/向量/CLIP 在服务端）

- 素材检索、向量索引、CLIP 编码、PostgreSQL 连接**已由服务端承担**，客户端一般**无需配置/修改**本文件。
- 保留字段仅当使用本地能力时按需设置：`nas_root`/`nas_user`/`nas_password`（本地 NAS 素材）、`save_thumbs`/`thumb_dir`（本地缩略图）、`ffmpeg_path`。
- 模板见 `studio/config/material_index_config.json.example`。

### 5.4 `studio/config/erp_config.json`（可选）

旺店通 ERP OpenAPI2 配置，仅知识库库存查询用到（默认沙箱账号，正式使用请替换）。模板见 `studio/config/erp_config.json.example`。

### 5.5 `studio/config/theme.json`（自动生成）

```json
{"theme": "dark"}
```

可选值 `dark` / `light` / `system`，由程序在用户切换主题时自动生成，**不入库**。

---

## 6. 数据库（服务端配置）

PostgreSQL + pgvector（素材向量检索）、MySQL（业务数据）、MongoDB（爬虫）、RustFS/S3（素材存储）**均在服务端部署与配置**，客户端部署**无需建库或连接**。

---

## 7. 模型权重（全部在服务端）

| 模型 | 用途 | 部署位置 |
|------|------|---------|
| VoxCPM2 | 声音克隆 | 服务端 |
| Chinese-CLIP | 向量检索 | 服务端 |
| Whisper large-v3 | 语音转文字 | 服务端 |
| PaddleOCR | 字幕检测/去字幕 | 服务端 |
| STTN/LaMa/ProPainter | 视频修复/去字幕 | 服务端 |
| Ollama 视觉模型 | 画面分析 | 服务端 |
| U2Net(rembg) | 本地抠图（可选，客户端按需） | 客户端可选 |

---

## 8. 子应用 Python 环境（客户端）

| 子应用 | Python 路径 | 用途 |
|--------|-----------|------|
| 主程序 | `python_embeded/python.exe` | 客户端 UI 与媒体预处理 |
| 素材浏览器 | 外部 Electron | 素材浏览 |

> VoxCPM2 / 去字幕 / CLIP / Whisper 等模型子应用**在服务端部署**，客户端无需安装其 Python 环境。

---

## 9. 已知问题与修复要点

### 9.1 Windows 中文编码
子进程输出中文时可能因 cp1252 编码崩溃。已修复入口（`sys.stdout.reconfigure(encoding="utf-8")`）：
- `studio/voxcpm_api_server.py`、`apps/vsr-v1.4.0/vsr_run.py`、`apps/vsr-v1.1.1-*/resources/vsr_run.py`

### 9.2 License 认证
默认**开启**：未激活设备启动会弹出激活对话框，需输入开发人员签发的激活码（JSON）。
- 激活对话框显示 16 位机器码，支持鼠标选中复制或点「📋 复制」按钮
- 开发跳过：设环境变量 `TINTIN_NO_LICENSE=1`
- 签发工具：`tools/license_tool.py`
- 白名单 `studio/config/trial_whitelist.json` 可免激活（已从 git 移除）

### 9.3 HuggingFace 镜像
`gui_main.py` 强制设置 `HF_ENDPOINT=https://hf-mirror.com`，本地按需下载模型（如 rembg、即梦依赖）时国内网络可直接下载。

> VoxCPM venv 依赖锁定、numpy DLL、去字幕 Python 路径等问题**均在服务端侧**，客户端不再遇到。

---

## 10. 外部服务依赖

| 服务 | 地址 | 用途 | 必需 |
|------|------|------|------|
| **统一计算节点** | `http://<server>:8000` | LLM / ASR / TTS / 视觉 / CLIP / OCR / 素材 / 成片 | **是** |
| DeepSeek API | `api.deepseek.com` | 文本模型（通常由服务端代理，客户端可不开通） | 服务端 |
| ComfyUI | `http://<server>:8188` | 图像生成（独立节点，按需） | 否 |
| RunningHub | `runninghub.cn` | 云端图像生成 | 否 |
| 抖音 | `douyin.com` | 直播切片录制 / 素材嗅探 | 否 |
| 旺店通 | `api.wangdian.cn` | ERP 库存查询 | 否 |

> PostgreSQL / MongoDB / RustFS 等服务端内部依赖，客户端无需直连。

---

## 11. 新电脑部署清单（客户端）

1. **拷贝客户端工程** 到目标电脑（可只含 `studio/`、`python_embeded/`、`apps/asset-browser/`、`ffmpeg/ffprobe`）
2. **放置 ffmpeg.exe / ffprobe.exe**（工程根目录或 PATH）
3. **配置统一计算节点**：编辑 `studio/config/ai_config.json`，填 `compute_server_url`（服务端地址），有需要再填 `llm_model` / `llm_vision_model`
4. **配置飞书**（如用飞书脚本创作）：复制 `config.ini.example` → `config.ini`，填 `[Feishu]`
5. **可选**：本地抠图/图层化需要时安装 NVIDIA 驱动；RunningHub/ERP 等按需填凭据
6. **运行** `studio\run_gui_integrated.bat`
7. **验证**：GUI「系统设置 → 平台接入 → 统一计算节点」测试连接；工作台一句话输入应能路由到对应功能

> 不再需要：本地 GPU 大显存、模型权重部署、PostgreSQL/MySQL/MongoDB 建库、本地 Ollama/ComfyUI/去字幕/VoxCPM 环境。