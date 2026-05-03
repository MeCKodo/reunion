# Reunion 安装指南（Windows）

> 给 Windows 同事的内部分发版本说明。如果你是开发者想自己打包，请看 `AGENTS.md` 的「打包」章节。

## 推荐：一行命令安装（最省事）

打开 **PowerShell**（开始菜单搜 PowerShell），把下面这行原样粘贴回车：

```powershell
iwr -useb https://github.com/MeCKodo/reunion/releases/latest/download/install.ps1 | iex
```

它会自动：

1. 检测你电脑的 CPU 架构（x64 / arm64）
2. 下载对应安装包（约 100 MB）
3. **per-user 静默安装** 到 `%LOCALAPPDATA%\Programs\Reunion`（不需要管理员密码）
4. 创建开始菜单和桌面快捷方式
5. 解除文件 Mark-of-the-Web，减少 SmartScreen 反复弹窗

完成后，开始菜单或桌面搜 "Reunion" 直接打开。

> 想装指定版本：`$env:REUNION_VERSION='v0.2.0'; iwr -useb .../install.ps1 | iex`
>
> 想要 portable（单 exe，免安装）：`$env:REUNION_PORTABLE='1'; iwr -useb .../install.ps1 | iex`，会下载到桌面，双击即用。

---

## 备选：手动下载安装包

如果 `iwr` 网络访问受限，或想自己挑版本：

### 1. 选包

| 你的电脑 | 下载文件 |
| --- | --- |
| 标准 Windows 10/11（绝大多数 Intel/AMD 笔记本和台式机） | `Reunion-Setup-{version}-x64.exe` |
| Snapdragon ARM Windows | `Reunion-Setup-{version}-arm64.exe` |
| 不想安装、解压即用 | `Reunion-{version}-x64-portable.exe` |

> 不知道是哪种？PowerShell 跑 `$env:PROCESSOR_ARCHITECTURE`：返回 `AMD64` 选 x64，`ARM64` 选 arm64。

下载页：<https://github.com/MeCKodo/reunion/releases/latest>

### 2. 跑安装器

双击下载下来的 `.exe`，按提示走一遍即可。默认装到 `%LOCALAPPDATA%\Programs\Reunion`，不需要管理员密码。

### 3. 首次启动（手动过 SmartScreen）

> 因为我们没买 EV 代码签名证书，Windows 第一次启动会出现「**Windows 已保护你的电脑**」蓝色弹窗。**这不是病毒**，只是 Microsoft Defender 的默认安全策略。

操作：
1. 弹窗里点左上角 **「更多信息」**
2. 出现 **「仍要运行」** 按钮，点它
3. 之后所有打开都不会再提示

---

## 数据存哪里

| 内容 | 路径 |
| --- | --- |
| 索引、标注 | `%APPDATA%\Reunion\data\` |
| 日志 | `%APPDATA%\Reunion\logs\main.log` |
| 运行时状态 | `%APPDATA%\Reunion\logs\runtime.json` |

> 在资源管理器地址栏直接粘 `%APPDATA%\Reunion` 回车就能进去。

数据源（只读）：

- Cursor: `%USERPROFILE%\.cursor\projects\*\agent-transcripts`
- Claude Code: `%USERPROFILE%\.claude\projects`
- Codex: `%USERPROFILE%\.codex\sessions`

> 三个都没装的话 App 启动正常，但列表是空的——这是预期的，不是 bug。

## AI 能力（Smart Export / Ask AI）

打开侧边栏顶部的齿轮 → **Settings** 可以接两类 AI provider：

### Cursor Agent（零配置默认）

App 默认走本机 `cursor-agent.exe`。检查：

```powershell
Get-Command cursor-agent -ErrorAction SilentlyContinue
```

没有的话，去 [Cursor 官网](https://cursor.com) 下 Cursor Desktop（自带 `cursor-agent` CLI）。Settings 里点「Login Cursor」会跑 `cursor-agent login`，浏览器完成 OAuth 后 token 落进 Windows Credential Manager（由 `cursor-agent` 自管，Reunion 不持有）。

> ⚠️ 单账号：`cursor-agent` 不支持账号隔离，同一时刻凭据库里只有一份 token。

### OpenAI / ChatGPT（多账号）

如果你已经付了 ChatGPT Plus / Pro / Team / Enterprise，可以直接复用订阅额度跑 Smart Export 和 Ask AI。需要本机有 `codex` CLI：

```powershell
Get-Command codex -ErrorAction SilentlyContinue
```

没有的话装一下（任选其一）：

```powershell
# winget
winget install OpenAI.Codex

# 或 npm
npm i -g @openai/codex
```

装好后在 Settings 点「Add ChatGPT account」，会跑 `codex login` 在 **专属 CODEX_HOME 目录** 下完成 OAuth（每个账号一个目录）。

### 默认 provider

Settings 底部可切换 Smart Export / Ask AI 默认走 OpenAI 还是 Cursor。**不配置任何 provider 也能用基础功能**，只影响 AI 衍生能力。

## 升级到新版

```powershell
iwr -useb https://github.com/MeCKodo/reunion/releases/latest/download/install.ps1 | iex
```

跟首次安装是同一条命令，会自动覆盖旧版本。

## 卸载

**一行命令**（推荐）：

```powershell
iwr -useb https://github.com/MeCKodo/reunion/releases/latest/download/uninstall.ps1 | iex
```

加 `REUNION_PURGE` 一并清除数据和日志：

```powershell
$env:REUNION_PURGE='1'; iwr -useb https://github.com/MeCKodo/reunion/releases/latest/download/uninstall.ps1 | iex
```

**手动**：开始菜单 → 设置 → 应用 → 找到 Reunion → 卸载。

完整清理（含数据）：

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\Reunion" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Reunion" -Recurse -Force -ErrorAction SilentlyContinue
```

## 排错

### 安装脚本提示「无法将"iwr"项识别为 cmdlet」

你在 cmd 里跑了，`iwr` 是 PowerShell alias。换 PowerShell 终端再跑。

### 启动后没反应 / 一闪而过

```powershell
Get-Content "$env:APPDATA\Reunion\logs\main.log" -Tail 100
```

把最后 100 行截图发给打包方。

### 端口冲突

App 每次启动会自动占用一个空闲端口（写在 `runtime.json` 的 `serverUrl` 字段里），不会和别的服务冲突。

### SmartScreen 反复弹

通常意味着下载来源没被识别为安全。一行命令安装方式已经在下载后跑了 `Unblock-File`，如果还有问题，手动跑：

```powershell
Unblock-File "$env:LOCALAPPDATA\Programs\Reunion\Reunion.exe"
```

### `cursor-agent` 找不到

把 Cursor Desktop 的安装目录加到 `PATH`，或在 Reunion 里设置环境变量 `CURSOR_AGENT_CMD` 指向 `cursor-agent.exe` 的绝对路径。

---

如有其他问题，直接钉/飞书联系打包人。
