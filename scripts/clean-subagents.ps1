# 清理 dsh-to-qq 会话里的子智能体目录（subagentCatalog）
# 用法：先完全退出 DSH，再跑这个脚本，然后重新打开 DSH。
# 保留 93b74d93-...（常规工位），其余按下面的 $ids 删。

$ErrorActionPreference = 'Stop'

$keep = '93b74d93-c0ae-4b3f-b0b0-13482bc3c3e6'
$ids = @(
  '8009462d-bcfe-45bc-be84-8129826cd38d',
  'a6eae9b4-7f3f-44ca-9407-1544234b9713',
  '8df39029-7a45-4ae5-8e08-d7168beb5b5f',
  '2469f81f-0863-429b-8679-65ccd470f0c8',
  '49255ab8-2a96-4134-9bd5-7998b3b2132e'
)

# 还在跑就退出，避免白改
$running = Get-Process -Name 'DeepSeek Harness','dsh' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host 'DSH 还开着，先完全退出再跑这个脚本。' -ForegroundColor Yellow
  Read-Host '按回车退出'
  exit 1
}

$dir = Join-Path $env:USERPROFILE '.dsh\storages\session_projcache\sessions'
$files = Get-ChildItem $dir -Filter 'session-*.json' -File
$touched = 0

foreach ($f in $files) {
  $p = $f.FullName
  $txt = Get-Content -LiteralPath $p -Raw
  if ($txt -notmatch 'subagentCatalog') { continue }

  $orig = $txt
  foreach ($id in $ids) {
    $pat = '\{\s*"version":\s*0,\s*"childId":\s*"' + [regex]::Escape($id) + '"[^}]*\},\s*'
    $txt = [regex]::Replace($txt, $pat, '')
  }
  if ($txt -eq $orig) { continue }

  try { $null = $txt | ConvertFrom-Json } catch {
    Write-Host "跳过（改完 JSON 解析失败）：$p" -ForegroundColor Red
    continue
  }

  Copy-Item -LiteralPath $p -Destination "$p.bak" -Force
  Set-Content -LiteralPath $p -Value $txt -NoNewline -Encoding UTF8
  $left = ([regex]::Matches($txt, 'childId')).Count
  Write-Host "已处理：$(Split-Path $p -Leaf)  剩余 childId=$left" -ForegroundColor Green
  $touched++
}

# 顺便删掉已经没用的子会话文件
foreach ($id in $ids) {
  $sp = Join-Path $dir "$id.json"
  if (Test-Path $sp) { Remove-Item -LiteralPath $sp -Force; Write-Host "删除子会话：$id" }
}

Write-Host ''
Write-Host "处理完成：$touched 个会话文件。现在可以打开 DSH。" -ForegroundColor Cyan
Read-Host '按回车退出'
