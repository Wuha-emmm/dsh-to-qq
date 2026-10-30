# 一键准备：检查环境 → 打包插件 → 生成安装指令
#
# 为什么要"准备"而不是直接装：DSH 桌面版没有对外暴露 dsh CLI，插件安装要经过
# DSH 内部的 plugin_manager（它会同时改 profile 的 package.json 与 cordis 补丁）。
# 脚本把能自动做的都做了（找 Node、打包、检查 SnowLuma、拼好命令），
# 最后给你一段可以直接粘给 DSH 的话，由它完成最后一步安装。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Open
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -SnowLumaDir D:\SnowLuma

param(
  [string]$Profile = 'desktop',
  [string]$SnowLumaDir = '',
  [string]$DshDir = '',
  [switch]$Open,
  [switch]$NoClipboard
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "  !!  $text" -ForegroundColor Yellow }

# ---------- 1. Node ----------

function Find-DshRoot {
  # Electron installers register an uninstall entry; that is the most reliable way
  # to find "DeepSeek Harness" without hardcoding a drive letter.
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $keys) {
    $entry = Get-ItemProperty $key -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like '*DeepSeek*' -and $_.InstallLocation } |
      Select-Object -First 1
    if ($entry -and (Test-Path $entry.InstallLocation)) { return $entry.InstallLocation }
  }
  return ''
}

function Find-Node {
  $candidates = @()
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  if ($DshDir -ne '') { $candidates += (Join-Path $DshDir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe') }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe')
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path $path)) { return $path }
  }
  return ''
}

Write-Step '检查 Node.js'
if ($DshDir -eq '') { $DshDir = Find-DshRoot }
if ($DshDir -ne '') { Write-Ok "DSH 目录：$DshDir" }
$nodePath = Find-Node
if ($nodePath -eq '') {
  throw '找不到 node.exe。请安装 Node.js 22+（https://nodejs.org/），或把 DSH 安装目录用 -DshDir 传进来。'
}
$versionText = & $nodePath --version
$major = [int]($versionText.TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node.js 版本过低：$versionText，需要 >= 22。" }
Write-Ok "node $versionText ($nodePath)"

# ---------- 2. 打包 ----------

Write-Step '打包插件'
$pnpmCandidates = @()
if ($DshDir -ne '') { $pnpmCandidates += (Join-Path $DshDir 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs') }
$pnpmCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs')
$pnpmScript = $pnpmCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

New-Item -ItemType Directory -Force 'dist' | Out-Null
if ($pnpmScript) {
  & $nodePath $pnpmScript pack --pack-destination dist | Out-Null
  Write-Ok "pnpm pack ($pnpmScript)"
} else {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { throw '既没有 pnpm 也没有 npm，无法打包。请安装 Node.js（自带 npm）。' }
  & $npm.Source pack --pack-destination dist | Out-Null
  Write-Ok 'npm pack'
}

$tgz = Get-ChildItem 'dist' -Filter 'dsh-to-qq-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $tgz) { throw '打包失败：dist 下没有生成 tgz。' }
$fileUrl = 'file:///' + ($tgz.FullName -replace '\\', '/')
Write-Ok "$($tgz.Name) ($([Math]::Round($tgz.Length / 1KB, 0)) KB)"

# ---------- 3. SnowLuma（可选） ----------

Write-Step '检查 SnowLuma（可选）'
if ($SnowLumaDir -eq '') {
  $guess = @('D:\SnowLuma', 'E:\SnowLuma', (Join-Path $env:USERPROFILE 'SnowLuma'))
  $SnowLumaDir = $guess | Where-Object { Test-Path $_ } | Select-Object -First 1
}
# 驱动器根目录下找一层，SnowLuma 常被解压到 E:\Open\SnowLuma 这类自建目录
if ($SnowLumaDir -eq '') {
  foreach ($drive in @('C:\', 'D:\', 'E:\', 'F:\')) {
    if (-not (Test-Path $drive)) { continue }
    $found = Get-ChildItem $drive -Directory -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'SnowLuma' } | Select-Object -First 1
    if ($found) { $SnowLumaDir = $found.FullName; break }
  }
}
if ($SnowLumaDir -and (Test-Path $SnowLumaDir)) {
  Write-Ok "找到：$SnowLumaDir"
  $onebot = Get-ChildItem (Join-Path $SnowLumaDir 'config') -Filter 'onebot_*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onebot) {
    Write-Ok 'OneBot 配置已存在（config/onebot_*.json）'
  } else {
    Write-Warn2 '还没扫码登录过小号（config 下没有 onebot_*.json）'
  }
} else {
  Write-Warn2 '没找到 SnowLuma。先按 docs/deploy.md 第 1 步装好，再回来装插件也可以。'
}

# ---------- 4. 生成安装指令 ----------

Write-Step '生成安装指令'
$prompt = @"
请帮我安装本地插件包，装完提醒我重启 DSH：

$fileUrl

装好后请确认：plugin_manager list_plugins 里能看到 dsh-to-qq，并且版本是最新的。
"@

if (-not $NoClipboard) {
  try {
    Set-Clipboard -Value $prompt
    Write-Ok '已复制到剪贴板'
  } catch {
    Write-Warn2 '剪贴板不可用，请手动复制下面的内容'
  }
}

Write-Host ''
Write-Host '下一步：把下面这段粘给 DSH（任意会话都行）' -ForegroundColor Cyan
Write-Host '------------------------------------------------------------'
Write-Host $prompt
Write-Host '------------------------------------------------------------'
Write-Host ''
Write-Host '装完之后：' -ForegroundColor Cyan
Write-Host '  1. 重启 DSH'
Write-Host '  2. 打开「设置 → QQ 桥接」，填 OneBot 的 HTTP / WS token'
Write-Host '  3. 发一条私聊测试'
Write-Host ''
Write-Host "完整步骤见 docs\deploy.md，隐私提醒见 SECURITY.md。"

if ($Open) {
  $exe = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) { Start-Process $exe; Write-Ok '已启动 DSH' }
  else { Write-Warn2 '没找到 DSH 可执行文件，请手动打开' }
}
