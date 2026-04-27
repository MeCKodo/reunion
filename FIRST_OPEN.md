# Reunion 安装指南

> 给团队同事的内部分发版本说明。如果你是开发者想自己打包，请看 `README.md` 的「打包与分发」章节。

## 推荐：一行命令安装（最省事）

打开 **终端**（启动台搜 "终端" / Terminal），把下面这行原样粘贴回车：

```bash
curl -fsSL https://github.com/MeCKodo/reunion/releases/latest/download/install.sh | bash
```

它会自动：
1. 检测你 Mac 的架构（M 系列 / Intel）
2. 下载对应 DMG（约 110 MB）
3. 安装到 `/Applications/Reunion.app`
4. **自动绕过 macOS Gatekeeper 拦截**，不用进系统设置点"仍要打开"

完成后，启动台搜 "Reunion" 直接打开，或终端 `open -a Reunion`。

> 想装指定版本：`REUNION_VERSION=v0.1.0 curl -fsSL .../install.sh | bash`

---

## 备选：手动下载 DMG

如果你公司限制了 `curl` 网络访问，或者想自己挑版本：

### 1. 选 DMG

| 你的 Mac | 下载文件 |
| --- | --- |
| **Apple Silicon**（M1 / M2 / M3 / M4） | `Reunion-0.1.0-arm64.dmg` |
| **Intel** Mac | `Reunion-0.1.0.dmg` |

> 不知道自己是哪种？终端运行 `uname -m`：返回 `arm64` 选第一个，返回 `x86_64` 选第二个。

下载页：<https://github.com/MeCKodo/reunion/releases/latest>

### 2. 安装

1. 双击 DMG 打开
2. 把 `Reunion.app` 拖到右边的 `Applications`
3. 在 Launchpad 或 `/Applications` 找到它

### 3. 首次打开（手动过 Gatekeeper）

> 因为我们没花 $99 买 Apple 公证（仅做了免费的 ad-hoc 自签名），macOS 第一次启动会拦一下。**这不是病毒**，只是 Apple 的默认安全策略。下面两种方法挑一种用，之后所有打开都直接进入。

**方法 A：图形界面**

1. 双击 `Reunion.app`
2. 弹窗提示「无法打开 "Reunion"」→ 点 **完成**
3. 打开 **系统设置** → **隐私与安全性**
4. 滑到底部，找到 _"已阻止 Reunion 的使用"_ 一行
5. 点右边的 **仍要打开** → 输入开机密码 → 再点一次 **打开**
6. 之后所有打开都不会再提示

**方法 B：一行命令**

```bash
xattr -cr /Applications/Reunion.app
```

---

## 数据存哪里

| 内容 | 路径 |
| --- | --- |
| 索引、标注 | `~/Library/Application Support/Reunion/data/` |
| 日志 | `~/Library/Logs/Reunion/main.log` |
| 运行时状态 | `~/Library/Logs/Reunion/runtime.json` |

数据源（只读）：
- Cursor: `~/.cursor/projects/*/agent-transcripts`
- Claude Code: `~/.claude/projects`
- Codex: `~/.codex/sessions`

> 三个都没装的话 App 启动正常，但列表是空的——这是预期的，不是 bug。

## AI 能力（Smart Export / Ask AI）

打开侧边栏顶部的齿轮 → **Settings** 可以接两类 AI provider：

### Cursor Agent（零配置默认）

App 默认走本机 `cursor-agent`。检查：

```bash
which cursor-agent
```

没有的话，去 [Cursor 官网](https://cursor.com) 下 Cursor Desktop（自带 `cursor-agent` CLI）。Settings 里点「Login Cursor」会跑 `cursor-agent login`，浏览器完成 OAuth 后 token 落进 macOS Keychain（由 `cursor-agent` 自管，Reunion 不持有）。

> ⚠️ 单账号：`cursor-agent` 不支持账号隔离，同一时刻 Keychain 里只有一份 token。

### OpenAI / ChatGPT（多账号）

如果你已经付了 ChatGPT Plus / Pro / Team / Enterprise，可以直接复用订阅额度跑 Smart Export 和 Ask AI。需要本机有 `codex` CLI：

```bash
which codex
```

没有的话装一下：

```bash
brew install codex            # 推荐
# 或：npm i -g @openai/codex   # 备选
```

装好后在 Settings 点「Add ChatGPT account」，会跑 `codex login` 在 **专属 CODEX_HOME 目录** 下完成 OAuth（每个账号一个目录，避免 token 互相覆盖）。Reunion 通过 OAuth access token 直接调 `chatgpt.com/backend-api/codex/responses` 流式拿结果，不会落 token 到自己的数据目录。

### 默认 provider

Settings 底部可切换 Smart Export / Ask AI 默认走 OpenAI 还是 Cursor。**不配置任何 provider 也能用基础功能**，只影响 AI 衍生能力。

## 升级到新版

```bash
curl -fsSL https://github.com/MeCKodo/reunion/releases/latest/download/install.sh | bash
```

跟首次安装是同一条命令，会自动覆盖旧版本。

## 卸载

**一行命令**（推荐）：

```bash
curl -fsSL https://github.com/MeCKodo/reunion/releases/latest/download/uninstall.sh | bash
```

加 `--purge` 参数可一并清除数据和日志：

```bash
curl -fsSL .../uninstall.sh | bash -s -- --purge
```

**手动**：

```bash
rm -rf "/Applications/Reunion.app"
rm -rf "$HOME/Library/Application Support/Reunion"
rm -rf "$HOME/Library/Logs/Reunion"
```

## 排错

### 安装脚本报错 "Permission denied"

试试加 sudo：`curl ... | sudo bash`。但通常不需要——`/Applications` 在大多数 Mac 上对当前用户可写。

### 启动后没反应 / 一闪而过

```bash
tail -100 "$HOME/Library/Logs/Reunion/main.log"
```

把 `main.log` 最后 100 行截图发给打包方。

### 端口冲突

App 每次启动会自动占用一个空闲端口（写在 `runtime.json` 的 `serverUrl` 字段里），不会和别的服务冲突。

### "App 损坏" 弹窗

跑一下 `xattr -cr /Applications/Reunion.app` 即可。这是 macOS 误报 ad-hoc 签名为「损坏」的常见现象。一行命令安装方式已经自动处理了，所以不会撞这个问题。

---

如有其他问题，直接钉/飞书联系打包人。
