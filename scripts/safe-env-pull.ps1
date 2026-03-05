param(
  [string]$Environment = "production",
  [string]$TargetPath = ".env.local",
  [string]$TempPath = ".env.vercel.tmp",
  [switch]$AllowEmptyOverwrite,
  [switch]$KeepTemp,
  [switch]$NoBackup,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Parse-EnvFile {
  param([string]$Path)

  $lines = @()
  $map = @{}
  if (-not (Test-Path $Path)) {
    return @{
      Lines = $lines
      Map = $map
    }
  }

  $content = Get-Content -Path $Path
  foreach ($line in $content) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $key = $Matches[1]
      $value = $Matches[2]
      $entry = [pscustomobject]@{
        Kind  = "kv"
        Key   = $key
        Value = $value
        Raw   = $line
      }
      $map[$key] = $entry
      $lines += $entry
    } else {
      $lines += [pscustomobject]@{
        Kind = "other"
        Raw  = $line
      }
    }
  }

  return @{
    Lines = $lines
    Map = $map
  }
}

function Normalize-EnvValue {
  param([string]$RawValue)
  if ($null -eq $RawValue) { return "" }
  $v = $RawValue.Trim()
  if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
    $v = $v.Substring(1, [Math]::Max(0, $v.Length - 2))
  }
  return $v.Trim()
}

function New-LineFromEntry {
  param([pscustomobject]$Entry)
  return "{0}={1}" -f $Entry.Key, $Entry.Value
}

Write-Host "Pulling Vercel env ($Environment) into temp file: $TempPath"
vercel env pull $TempPath --environment=$Environment --yes | Out-Null

$source = Parse-EnvFile -Path $TempPath
$target = Parse-EnvFile -Path $TargetPath

$updates = @{}
$protected = @()
$added = @()
$updated = @()

foreach ($key in $source.Map.Keys) {
  $incoming = $source.Map[$key]
  $incomingNorm = Normalize-EnvValue -RawValue $incoming.Value
  $incomingEmpty = [string]::IsNullOrWhiteSpace($incomingNorm)

  $existing = $null
  $hasExisting = $target.Map.ContainsKey($key)
  if ($hasExisting) {
    $existing = $target.Map[$key]
  }

  if ($incomingEmpty -and $hasExisting -and -not $AllowEmptyOverwrite) {
    $existingNorm = Normalize-EnvValue -RawValue $existing.Value
    if (-not [string]::IsNullOrWhiteSpace($existingNorm)) {
      $protected += $key
      continue
    }
  }

  $updates[$key] = $incoming
}

$outLines = @()
$seen = @{}
foreach ($line in $target.Lines) {
  if ($line.Kind -ne "kv") {
    $outLines += $line.Raw
    continue
  }

  $key = $line.Key
  $seen[$key] = $true
  if ($updates.ContainsKey($key)) {
    $outLines += (New-LineFromEntry -Entry $updates[$key])
    $updated += $key
  } else {
    $outLines += $line.Raw
  }
}

foreach ($key in $updates.Keys) {
  if (-not $seen.ContainsKey($key)) {
    $outLines += (New-LineFromEntry -Entry $updates[$key])
    $added += $key
  }
}

if ($DryRun) {
  Write-Host "Dry run only. No files written."
} else {
  if ((Test-Path $TargetPath) -and -not $NoBackup) {
    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $backupPath = "$TargetPath.bak.$stamp"
    Copy-Item -Path $TargetPath -Destination $backupPath -Force
    Write-Host "Backup created: $backupPath"
  }
  $outLines | Set-Content -Path $TargetPath -Encoding UTF8
  Write-Host "Updated: $TargetPath"
}

if (-not $KeepTemp -and (Test-Path $TempPath)) {
  Remove-Item $TempPath -Force
}

Write-Host ""
Write-Host "Summary"
Write-Host ("- Updated keys:   {0}" -f $updated.Count)
Write-Host ("- Added keys:     {0}" -f $added.Count)
Write-Host ("- Protected keys: {0}" -f $protected.Count)
if ($protected.Count -gt 0) {
  Write-Host ("  {0}" -f ($protected -join ", "))
}
Write-Host ""
Write-Host "Usage:"
Write-Host "  pwsh -File scripts/safe-env-pull.ps1"
Write-Host "  pwsh -File scripts/safe-env-pull.ps1 -Environment preview"
Write-Host "  pwsh -File scripts/safe-env-pull.ps1 -AllowEmptyOverwrite"
