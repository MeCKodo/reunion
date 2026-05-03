<#
.SYNOPSIS
  Reunion 一键安装脚本（Windows，PowerShell 5.1+ / 7+）。

.DESCRIPTION
  类似 install.sh 在 macOS 上做的事，在 Windows 上一行命令搞定：
    1. 检测 CPU 架构（x64 / arm64）
    2. 从 GitHub Releases 下载对应安装包
    3. 静默运行 NSIS 安装器（per-user，安装到 %LOCALAPPDATA%\Programs\Reunion）
    4. 解除下载文件的 Mark-of-the-Web，避免 SmartScreen 反复弹
    5. 提示首次启动方式

.EXAMPLE
  PS> iwr -useb https://github.com/MeCKodo/reunion/releases/latest/download/install.ps1 | iex

.EXAMPLE
  # 装指定版本
  PS> $env:REUNION_VERSION='v0.2.0'; iwr -useb .../install.ps1 | iex

.EXAMPLE
  # 不装、只下载 portable exe 到当前目录
  PS> $env:REUNION_PORTABLE='1'; iwr -useb .../install.ps1 | iex
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---------- 辅助 ----------
function Write-Step($msg)  { Write-Host "▸ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "✗ $msg" -ForegroundColor Red }
function Write-Hint($msg)  { Write-Host "  $msg" -ForegroundColor DarkGray }

$Repo       = if ($env:REUNION_REPO)    { $env:REUNION_REPO }    else { 'MeCKodo/reunion' }
$AppName    = 'Reunion'
$Version    = if ($env:REUNION_VERSION) { $env:REUNION_VERSION } else { 'latest' }
$WantPortable = $env:REUNION_PORTABLE -eq '1'

Write-Host ""
Write-Host "Reunion 安装器 ($Repo)" -ForegroundColor Cyan
Write-Host ""

# ---------- 前置检查 ----------
if (-not [System.Environment]::Is64BitOperatingSystem) {
  Write-Err "Reunion 仅支持 64 位 Windows。"
  exit 1
}

# 架构判定（PowerShell 5.1 没有 $env:PROCESSOR_ARCHITECTURE 完整覆盖 ARM64，
# 用 RID 更稳）。
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { 'x64' }
}
# 在 ARM64 设备上以 x86 emulation 跑 PowerShell 时也能识别到。
if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }

Write-Step "检测到架构：$arch"

# ---------- 解析下载 URL ----------
if ($Version -eq 'latest') {
  $base = "https://github.com/$Repo/releases/latest/download"
  Write-Step "查询最新版本..."
  try {
    # 跟随 GitHub 的 latest 重定向拿到真实 tag
    $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
      -MaximumRedirection 0 -ErrorAction SilentlyContinue
  } catch {
    $resp = $_.Exception.Response
  }
  $resolvedTag = $null
  if ($resp -and $resp.Headers -and $resp.Headers.Location) {
    $loc = $resp.Headers.Location.ToString()
    if ($loc -match '/tag/([^/?#]+)') { $resolvedTag = $Matches[1] }
  }
  if (-not $resolvedTag) {
    Write-Warn2 "无法解析最新版本号，仍按 latest 重定向下载。"
    $resolvedTag = 'latest'
  } else {
    Write-Ok "最新版本：$resolvedTag"
  }
} else {
  $base = "https://github.com/$Repo/releases/download/$Version"
  $resolvedTag = $Version
}

$versionNum = $resolvedTag.TrimStart('v')

if ($WantPortable) {
  $assetName = "$AppName-$versionNum-$arch-portable.exe"
} else {
  $assetName = "$AppName-Setup-$versionNum-$arch.exe"
}
$downloadUrl = "$base/$assetName"

# ---------- 下载 ----------
$tmp = Join-Path $env:TEMP "reunion-install-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tmp | Out-Null
$dst = Join-Path $tmp $assetName

Write-Step "下载 $assetName"
Write-Hint $downloadUrl
try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $dst -UseBasicParsing
} catch {
  Write-Err "下载失败：$($_.Exception.Message)"
  Write-Hint "1) 网络是否能访问 github.com"
  Write-Hint "2) Release 是否存在：https://github.com/$Repo/releases"
  Write-Hint "3) 文件名是否对得上：$assetName"
  exit 1
}
$sizeMb = [Math]::Round((Get-Item $dst).Length / 1MB, 1)
Write-Ok "已下载（${sizeMb} MB）"

# 解除 Zone.Identifier，避免 SmartScreen / 资源管理器一直警告。
try { Unblock-File -Path $dst -ErrorAction SilentlyContinue } catch {}

# ---------- portable：拷到 Desktop 后退出 ----------
if ($WantPortable) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $finalPath = Join-Path $desktop $assetName
  Copy-Item -Path $dst -Destination $finalPath -Force
  Write-Ok "Portable 版本已保存到桌面：$finalPath"
  Write-Host ""
  Write-Host "  双击运行即可，无需安装。" -ForegroundColor Green
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}

# ---------- NSIS 静默安装（per-user，无管理员）----------
Write-Step "安装到 %LOCALAPPDATA%\Programs\$AppName"
$installerArgs = @(
  '/S',                       # NSIS silent
  '/allusers=0',              # per-user
  "/D=$env:LOCALAPPDATA\Programs\$AppName"  # NSIS /D 必须是最后一个参数
)
$proc = Start-Process -FilePath $dst -ArgumentList $installerArgs -PassThru -Wait
if ($proc.ExitCode -ne 0) {
  Write-Err "安装器退出码 $($proc.ExitCode)。"
  Write-Hint "你可以手动双击 $dst 跑安装。"
  exit 1
}
Write-Ok "已安装"

# ---------- 清理 ----------
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 完成 ----------
$exePath = Join-Path "$env:LOCALAPPDATA\Programs\$AppName" "$AppName.exe"
Write-Host ""
Write-Host "安装成功！" -ForegroundColor Green
Write-Host ""
Write-Host "  开始菜单或桌面搜 ""$AppName"" 直接打开" -ForegroundColor White
Write-Host "  或命令行：" -ForegroundColor White
Write-Host "    & '$exePath'" -ForegroundColor Gray
Write-Host ""
Write-Host "  数据/日志位置：" -ForegroundColor DarkGray
Write-Host "    %APPDATA%\$AppName\data\"  -ForegroundColor DarkGray
Write-Host "    %APPDATA%\$AppName\logs\"  -ForegroundColor DarkGray
Write-Host ""
Write-Host "  卸载（一行）：" -ForegroundColor White
Write-Host "    iwr -useb https://github.com/$Repo/releases/latest/download/uninstall.ps1 | iex" -ForegroundColor Gray
Write-Host ""

# 如果是 SmartScreen / Defender 警告导致的“此应用未签名”，给一句简短提示。
Write-Host "  小贴士：首次启动如出现 ""Windows 已保护你的电脑""，点 ""更多信息"" → ""仍要运行""。" -ForegroundColor DarkGray
