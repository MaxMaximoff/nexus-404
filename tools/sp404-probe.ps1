# Read-only probe of a Roland SP-404MKII over its CDC-ACM serial port.
# Sends only: status (FE), project settings (FD), pad block (9E). Protocol: SparkyMK2/docs/re.
# Usage: powershell -ExecutionPolicy Bypass -File tools\sp404-probe.ps1 [-Port COM3] [-Bank A]
#        powershell -ExecutionPolicy Bypass -File tools\sp404-probe.ps1 -Pad B1 [-Save before.txt]
#        powershell -ExecutionPolicy Bypass -File tools\sp404-probe.ps1 -All
#   -Pad dumps every field of one pad block; -Save also writes the dump to a file (for diffing).
#   -All lists every non-empty pad of the current project.
param([string]$Port = '', [string]$Bank = 'A', [string]$Pad = '', [string]$Save = '', [switch]$All)

$ErrorActionPreference = 'Stop'
if (-not $Port) {
  $dev = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_0582&PID_02E7' -and $_.FriendlyName -match '\((COM\d+)\)' } | Select-Object -First 1
  if (-not $dev) { throw 'SP-404MKII serial port (0582:02E7) not found' }
  $Port = [regex]::Match($dev.FriendlyName, 'COM\d+').Value
}

$sp = New-Object System.IO.Ports.SerialPort $Port, 921600, 'None', 8, 'One'
$sp.Handshake = 'None'; $sp.ReadTimeout = 20; $sp.WriteTimeout = 2000; $sp.ReadBufferSize = 1MB
$sp.Open(); $sp.DtrEnable = $true; $sp.RtsEnable = $true
Start-Sleep -Milliseconds 350

$script:rx = New-Object System.Collections.Generic.List[byte]
$tmp = New-Object byte[] 65536

function Pump {
  try { $n = $sp.Read($tmp, 0, $tmp.Length); for ($i = 0; $i -lt $n; $i++) { $script:rx.Add($tmp[$i]) } } catch [TimeoutException] {}
}
# Next complete frame from the stream, or $null.
function Next-Frame {
  while ($script:rx.Count -gt 0 -and $script:rx[0] -ne 0x12 -and $script:rx[0] -ne 0x13) { $script:rx.RemoveAt(0) }
  if ($script:rx.Count -lt 12) { return $null }
  if ($script:rx[0] -eq 0x12) {
    $f = $script:rx.GetRange(0, 12).ToArray(); $script:rx.RemoveRange(0, 12)
    return @{ Ch = $f[3]; Payload = [byte[]]$f[4..(3 + [Math]::Min($f[11], 7))] }
  }
  if ($script:rx.Count -lt 16) { return $null }
  $len = [BitConverter]::ToUInt32($script:rx.GetRange(12, 4).ToArray(), 0)
  if ($script:rx.Count -lt 16 + $len) { return $null }
  $f = $script:rx.GetRange(0, 16 + $len).ToArray(); $script:rx.RemoveRange(0, 16 + $len)
  return @{ Ch = $f[3]; Payload = [byte[]]$f[16..(15 + $len)] }
}
function Send-Short([byte[]]$payload) {
  $f = New-Object byte[] 12; $f[0] = 0x12; $f[1] = 0x60; $f[2] = 0xE0; $f[3] = 0x05
  [Array]::Copy($payload, 0, $f, 4, $payload.Length); $f[11] = $payload.Length
  $sp.Write($f, 0, 12)
}
# Send, then return the first control frame accepted by $match; others are collected in $script:extra.
function Transact([byte[]]$payload, [scriptblock]$match, [int]$ms = 2000) {
  $script:extra = @()
  Send-Short $payload
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) {
    Pump
    while ($m = Next-Frame) { if ($m.Ch -eq 5 -and (& $match $m.Payload)) { return $m.Payload } else { $script:extra += , $m } }
  }
  throw "timeout waiting for reply to $(($payload | % { $_.ToString('x2') }) -join ' ')"
}
function Hex([byte[]]$b) { ($b | ForEach-Object { $_.ToString('x2') }) -join ' ' }
function U32([byte[]]$b, [int]$at) { [BitConverter]::ToUInt32($b, $at) }
function Text([byte[]]$b, [int]$at, [int]$n) { ([Text.Encoding]::ASCII.GetString($b, $at, $n)).TrimEnd([char]0, ' ') }

function Read-Block([int]$idx) {
  $lo = [byte]($idx -band 0xFF); $hi = [byte]($idx -shr 8)
  Transact ([byte[]](0x9E, $lo, $hi)) { param($p) $p[0] -eq 0x1E -and $p[1] -eq $lo -and $p[2] -eq $hi -and $p.Length -gt 200 }
}

# Field names by index (field n <-> parameter id 0x66 + n for n = 3..24), from SparkyMK2 docs/re/03-parameters.md.
$fieldNames = @{ 0 = 'size'; 1 = 'start(byte)'; 2 = 'end(byte)'; 3 = '69 level'; 4 = '6A gate'; 5 = '6B loop'; 6 = '6C ?'
  7 = '6D mute grp'; 8 = '6E bpm sync'; 9 = '6F bpm x100'; 10 = '70 flags'; 11 = '71 loop top(byte)'; 12 = '72 ?'
  13 = '73 pitch coarse'; 14 = '74 pitch fine'; 15 = '75 play mode'; 16 = '76 time stretch'; 17 = '77 vinyl'
  18 = '78 balance'; 19 = '79 pad link'; 20 = '7A bus fx'; 21 = '7B roll'; 22 = '7D attack'; 23 = '7E hold'; 24 = '7F release' }

if ($Pad) {
  try {
    if ($Pad -notmatch '^([A-Ja-j])(\d{1,2})$' -or [int]$Matches[2] -lt 1 -or [int]$Matches[2] -gt 16) { throw "bad pad '$Pad' (A1..J16)" }
    $idx = ([int][char]$Matches[1].ToUpper() - 65) * 16 + [int]$Matches[2] - 1
    $blk = Read-Block $idx
    $out = @("pad $($Pad.ToUpper()) (index $idx), name '$(Text $blk 175 24)'")
    for ($n = 0; $n -lt 43; $n++) {
      $v = U32 $blk (3 + 4 * $n)
      $out += "  f{0,-2} {1,-18} {2,11}  0x{2:X8}" -f $n, $fieldNames[$n], $v
    }
    $chops = for ($i = 0; $i -lt 16; $i++) { [BitConverter]::ToInt32($blk, 199 + 4 * $i) }
    $out += "  name   $(Hex $blk[175..198])"
    $out += "  chops  $($chops -join ' ')"
    $tail = for ($i = 0; $i -lt 16; $i++) { U32 $blk (263 + 4 * $i) }
    $out += "  tail   $($tail -join ' ')   (f65 263, 8A groove 267, 8B rate 271, 8C humanize 275, 8D 279)"
    $out
    if ($Save) { $out | Set-Content -Encoding utf8 $Save; "saved to $Save" }
  } finally { $sp.DtrEnable = $false; $sp.RtsEnable = $false; $sp.Close() }
  return
}

try {
  $st = Transact ([byte[]](0xFE, 0x66, 0x00)) { param($p) $p[0] -eq 0x7E }
  $proj = $st[1]
  "status   : $(Hex $st)"
  "           project $($proj + 1), selected $([char](65 + $st[3]))$($st[5] + 1), working mode $($st[12])"

  $ps = Transact ([byte[]](0xFD, $proj, 0x00)) { param($p) $p[0] -eq 0x7D -and $p[1] -eq $proj }
  $w0 = U32 $ps 3
  "project  : '$(Text $ps 115 32)'  tempo $(($w0 -band 0xFFFF) / 100)  tempo select $(if (($w0 -shr 16) -band 1) {'project'} else {'bank'})"
  $banks = for ($b = 0; $b -lt 10; $b++) {
    $w = U32 $ps (3 + 4 * (12 + $b)); "{0}:{1}{2}" -f [char](65 + $b), ((($w -shr 1) -band 0xFFFF) / 100), $(if ($w -band 1) { '(P)' } else { '' })
  }
  "banks    : $($banks -join ' ')"
  # The 16 project names follow the 7D reply.
  $names = @{}; $sw = [Diagnostics.Stopwatch]::StartNew()
  foreach ($m in $script:extra) { if ($m.Payload[0] -eq 0x35) { $names[[int]$m.Payload[1]] = Text $m.Payload 2 ($m.Payload.Length - 2) } }
  while ($names.Count -lt 16 -and $sw.ElapsedMilliseconds -lt 1500) {
    Pump; while ($m = Next-Frame) { if ($m.Payload[0] -eq 0x35) { $names[[int]$m.Payload[1]] = Text $m.Payload 2 ($m.Payload.Length - 2) } }
  }
  "projects : " + ((0..15 | ForEach-Object { "$($_ + 1)=$($names[$_])" }) -join ', ')

  # PowerShell variable names are case-insensitive: the loop counter must not be called $pad (clashes with -Pad).
  $banksToRead = if ($All) { 0..9 } else { @([int][char]$Bank.ToUpper() - 65) }
  foreach ($bankIdx in $banksToRead) {
    $bl = [char](65 + $bankIdx)
    if (-not $All) { "bank $bl pads:" }
    for ($i = 0; $i -lt 16; $i++) {
      $idx = $bankIdx * 16 + $i
      $blk = Read-Block $idx
      $f = { param($n) U32 $blk (3 + 4 * $n) }
      $size = & $f 0
      if ($size -eq 0) { if (-not $All) { "  {0}{1,-3} empty" -f $bl, ($i + 1) }; continue }
      $flags = & $f 10
      "  {0}{1,-3} {2,-24} {3,9} B  bpm {4,6:N2}{5}  lvl {6,3}  {7}{8}  flags {9}  f27 {10} f29 {11} f33 {12}" -f $bl, ($i + 1), (Text $blk 175 24), $size,
        ((& $f 9) / 100), $(if (& $f 8) { ' sync' } else { '' }), (& $f 3),
        $(if ($flags -band 32) { 'one-shot' } elseif (& $f 4) { 'gate' } else { '-' }), $(if (& $f 5) { ' loop' } else { '' }),
        $flags, (& $f 27), (& $f 29), (& $f 33)
    }
  }
} finally {
  $sp.DtrEnable = $false; $sp.RtsEnable = $false; $sp.Close()
}
