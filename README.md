# 螺丝钉-电商智能体矩阵 V3（Electron 客户端）

电商智能体矩阵的桌面客户端，基于 Electron + Vue3 + Vite。本地知识库/推理采用 dual-mode，支持服务端与本地模型自动降级。

## 目录

- 前端/渲染进程与打包配置：`desktop/`
- 设计参考：`design/`、`design_assets/`
- 打包/验证的临时产物与日志：`test/`（与工作代码隔离）

## 开发启动

```powershell
# 一键开发（Vite HMR + Electron 壳），双击或命令行执行
.\start-dev.bat

# 或手动
cd desktop
npm run dev
```

- 前端 `http://localhost:5173`（热更新）；Electron 壳加载该地址。
- 停止：关闭该控制台窗口或 Ctrl+C。

## 打包（生成 exe / 安装包）

所有打包命令在 `desktop/` 目录下执行。`dist/` 为输出目录（位于项目根）。

| 命令 | 原生模块(better-sqlite3/onnxruntime) | 缺失资源跳过 | 产物 |
|---|---|---|---|
| `npm run build` | 真实重建（推荐） | 否（打包 `../resources`） | NSIS 安装包 |
| `npm run build:dir` | 真实重建 | 否 | 解包目录 + exe |
| `npm run build:no-native` | 跳过 | 是 | NSIS 安装包 |
| `npm run build:dir:no-native` | 跳过 | 是 | 解包目录 + exe |

### 何时用哪套

- **正式发布 / 打包机齐全**（能下载 Electron 预编译包或有 C++ 编译工具链）→ 用默认的
  `npm run build` 或 `npm run build:dir`。
  该模式会重编译 better-sqlite3、onnxruntime-node 等原生模块为 Electron ABI，原生能力才能生效。
- **仅跑通流程 / 无工具链 / 网络受限** → 用 `:no-native` 版本（`build:no-native` / `build:dir:no-native`）。
  它们通过 `-c builder-skip.json` 同时：
  - 跳过原生重编译（`npmRebuild: false`）
  - 跳过对缺失 `resources/` 的打包（`extraResources: []`）

  ⚠️ 注意：`:no-native` 产出的包里原生模块仍是 Node ABI，**运行时可能无法在 Electron 中加载**，
  仅建议用于验证打包流程，不建议作为正式产物分发。

### 显式开关机制

- `desktop/package.json` 的 `build` 段：默认真实行为（`npmRebuild: true` + 完整 `extraResources`），
  指向 `../resources/bin`、`../resources/icons`、`../resources/studio-legacy`。
- `desktop/builder-skip.json`：`{ "npmRebuild": false, "extraResources": [] }`，
  由 `:no-native` 脚本通过 `-c builder-skip.json` 覆盖加载（配置合并，覆盖文件优先）。

> 同样的说明也已以内联方式写在 `desktop/package.json` 的 `scripts` 里（npm 惯用的 `//` 注释键，
> 合法 JSON、npm 自动忽略，不影响执行）：`"// build 打包说明"`、`"// build:no-native 说明"`。

### 需要补齐的运行时资源（缺失时默认打包会报错）

1. `resources/bin/ffmpeg.exe`、`ffprobe.exe`
2. `resources/icons/`
3. `resources/studio-legacy/bridge.exe`

补齐后在 `desktop/` 下重新执行 `npm run install` 并跑默认打包命令即可（无需改配置）。

## 常见问题

- **双击 `start-dev.bat` 无反应/闪退**：多为残留 Electron 实例占用单实例锁所致。
  请在任务管理器中结束残留 `electron.exe`，或删除
  `%APPDATA%\tintin-client-electron`（重置本地缓存/偏好，不影响代码），再重试。
- **打包报 `app-builder.exe … ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` / `Access is denied`**：
  多为受限终端/安全软件对缓存或锁文件的访问限制。请在正常 Windows 终端执行，或加白权限。