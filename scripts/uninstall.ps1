<#
.SYNOPSIS
  Reunion 一键卸载脚本（Windows）。

.DESCRIPTION
  对应 install.ps1 的 NSIS 安装路径。会：
    1. 关闭运行中的 Reunion 实例
    2. 调用 NSIS 卸载器（per-user 默认路径，或注册表里查到的路径）
    3. （可选）传 -Purge 一并删除数据 + 日志

.EXAMPLE
  PS> iwr -useb https://github.com/MeCKodo/reunion/releases/latest/download/uninstall.ps1 | iex

.EXAMPLE
  # 连数据一起删
  PS> $env:REUNION_PURGE='1'; iwr -useb .../uninstall.ps1 | iex
#>

[CmdletBinding()]
param(
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "▸ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "! $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "✗ $msg" -ForegroundColor Red }

# REUNION_PURGE 环境变量也可以触发 purge（方便 iwr | iex 用法）。
if (-not $Purge -and $env:REUNION_PURGE -eq '1') { $Purge = $true }

$AppName  = 'Reunion'
$DefaultInstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$DataDir  = Join-Path $env:APPDATA $AppName
$LogsDir  = Join-Path $env:APPDATA "$AppName\logs"

Write-Host ""
Write-Host "Reunion 卸载器" -ForegroundColor Red
Write-Host ""

# ---------- 关闭运行中的 Reunion ----------
$running = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if ($running) {
  Write-Step "$AppName 正在运行，正在关闭..."
  $running | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
  Start-Sleep -Seconds 2
  Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# ---------- 找卸载器 ----------
# NSIS per-user 写到 HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Reunion
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
$uninstallString = $null
$installLocation = $null
if (Test-Path $uninstallKey) {
  $reg = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
  if ($reg) {
    $uninstallString = $reg.QuickUninstallString
    if (-not $uninstallString) { $uninstallString = $reg.UninstallString }
    $installLocation = $reg.InstallLocation
  }
}
if (-not $installLocation) { $installLocation = $DefaultInstallDir }

# ---------- 跑卸载器 ----------
if ($uninstallString -and (Test-Path ($uninstallString -replace '"', ''))) {
  Write-Step "运行 NSIS 卸载器"
  # NSIS uninstaller 接受 /S 静默
  $exe = ($uninstallString -split ' ')[0].Trim('"')
  $proc = Start-Process -FilePath $exe -ArgumentList '/S' -PassThru -Wait
  if ($proc.ExitCode -ne 0) {
    Write-Warn2 "卸载器退出码 $($proc.ExitCode)，可能已部分清理。"
  } else {
    Write-Ok "已卸载"
  }
} elseif (Test-Path $installLocation) {
  Write-Warn2 "未找到 NSIS 注册表项，回退到目录硬删：$installLocation"
  Remove-Item $installLocation -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok "目录已删除"
} else {
  Write-Warn2 "未找到 $AppName 安装（可能已卸载）"
}

# ---------- 清理 portable exe + Desktop 快捷方式残留 ----------
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop "$AppName.lnk"
if (Test-Path $lnk) {
  Remove-Item $lnk -Force -ErrorAction SilentlyContinue
  Write-Ok "桌面快捷方式已删除"
}

# ---------- Purge 数据 ----------
if ($Purge) {
  if (Test-Path $DataDir) {
    Write-Step "删除数据目录 $DataDir"
    Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "已删除"
  }
} else {
  $remaining = @()
  if (Test-Path $DataDir) { $remaining += $DataDir }
  if ($remaining.Count -gt 0) {
    Write-Host ""
    Write-Host "保留了你的数据和日志：" -ForegroundColor DarkGray
    foreach ($d in $remaining) { Write-Host "  $d" -ForegroundColor DarkGray }
    Write-Host ""
    Write-Host "想一并删除？" -ForegroundColor DarkGray
    Write-Host "  Remove-Item '$DataDir' -Recurse -Force" -ForegroundColor DarkGray
    Write-Host "  # 或重跑：iwr -useb .../uninstall.ps1 | iex 时设置 `$env:REUNION_PURGE='1'" -ForegroundColor DarkGray
  }
}

Write-Host ""
Write-Host "卸载完成" -ForegroundColor Green
Write-Host ""
