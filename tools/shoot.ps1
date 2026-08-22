param(
  [Parameter(Mandatory=$true)][string]$Name,
  [Parameter(Mandatory=$true)][string]$Query,
  [int]$W = 960,
  [int]$H = 540,
  [int]$Budget = 25000,
  [int]$Cols = 6,
  [int]$Rows = 4
)
# 无头 Chrome 截图 + 数值化分析（本模型看不了图，靠网格数据判断画面）
$ErrorActionPreference = 'Stop'
$env:NODE_OPTIONS = ''
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$dir = 'D:\dsh-home\poolrooms\tools\shots'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dir ("prof-" + $Name)) | Out-Null
$out = Join-Path $dir "$Name.png"
$log = Join-Path $dir "$Name.log"
if (Test-Path $out) { Remove-Item $out -Force }
$url = "http://127.0.0.1:8123/?$Query"
$a = @(
  '--headless=new','--disable-gpu','--enable-unsafe-swiftshader','--use-angle=swiftshader',
  '--hide-scrollbars',"--window-size=$W,$H","--virtual-time-budget=$Budget","--screenshot=$out",
  '--enable-logging=stderr','--log-level=0','--no-first-run','--no-default-browser-check',
  "--user-data-dir=$dir\prof-$Name", $url
)
& $chrome @a 2>&1 | Out-File -FilePath $log -Encoding utf8
Write-Output "==== $Name  ($url) ===="
$bad = Select-String -Path $log -Pattern 'INVALID|Uncaught|SyntaxError|TypeError|is not a function|THREE\.\w+:' -AllMatches
if ($bad) {
  Write-Output ("  !! problems: " + $bad.Count)
  $bad | Select-Object -First 4 | ForEach-Object {
    $s = $_.Line.Trim(); $i = $s.IndexOf('"'); if ($i -lt 0) { $i = 0 }
    Write-Output ('     ' + $s.Substring($i, [Math]::Min(170, $s.Length - $i)))
  }
}
Select-String -Path $log -Pattern 'poolrooms\] ready' | ForEach-Object {
  $s = $_.Line.Trim(); Write-Output ('  ' + $s.Substring($s.IndexOf('"')))
}
if (Test-Path $out) {
  node 'D:\dsh-home\poolrooms\tools\analyze-shot.mjs' $out $Cols $Rows
} else {
  Write-Output '  !! NO SCREENSHOT'
}
