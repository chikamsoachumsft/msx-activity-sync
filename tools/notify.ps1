# Activity Sync - toast notifier
# Reads the latest sync report, extracts the action-required metrics, and
# shows a Windows toast if anything needs human attention.
#
# Usage: pwsh -File tools/notify.ps1 [-ReportsDir <path>]
#
# Notification strategy:
#   1. Try BurntToast module (richer toasts, click-to-open report)
#   2. Fall back to a small WinRT-based toast (zero deps)
#   3. Fall back to a balloon tip (last resort, works on any Windows)
#
# Designed to be best-effort: failures are logged but never crash the sync.
[CmdletBinding()]
param(
  [string]$ReportsDir
)

$ErrorActionPreference = "Continue"

if (-not $ReportsDir) {
  $candidate = Join-Path (Join-Path $PSScriptRoot "..") "reports"
  $resolved = (Resolve-Path $candidate -ErrorAction SilentlyContinue).Path
  $ReportsDir = if ($resolved) { $resolved } else { $candidate }
}

function Get-LatestReport {
  if (-not (Test-Path $ReportsDir)) { return $null }
  Get-ChildItem -Path $ReportsDir -Filter "*_sync_*.md" -File |
    Sort-Object Name -Descending |
    Select-Object -First 1
}

function Get-ActionMetrics($reportPath) {
  $content = Get-Content $reportPath -Raw
  $extract = {
    param($pattern, $default = 0)
    if ($content -match $pattern) { return [int]$Matches[1] }
    return $default
  }
  return [PSCustomObject]@{
    Created       = & $extract '\|\s*Tasks Created\s*\|\s*(\d+)\s*\|'
    AlreadyExists = & $extract '\|\s*Already in CRM \(skipped\)\s*\|\s*(\d+)\s*\|'
    Failed        = & $extract '\|\s*Failures\s*\|\s*(\d+)\s*\|'
    FollowUp      = & $extract '\|\s*Follow-Up Required\s*\|\s*(\d+)\s*\|'
    NeedsAction   = & $extract '\|\s*Needs Human Action\s*\|\s*(\d+)\s*\|'
  }
}

function Show-ToastBurnt {
  param($title, $body, $reportPath)
  if (-not (Get-Module -ListAvailable -Name BurntToast)) { return $false }
  try {
    Import-Module BurntToast -ErrorAction Stop
    $btn = New-BTButton -Content "Open report" -Arguments $reportPath -ActivationType Protocol
    # scenario=Reminder makes the toast persistent (won't auto-dismiss)
    New-BurntToastNotification -Text $title, $body -Button $btn -AppLogo $null -Scenario Reminder
    return $true
  } catch {
    Write-Host "[notify] BurntToast failed: $($_.Exception.Message)"
    return $false
  }
}

function Show-ToastWinRT {
  param($title, $body)
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $template = @"
<toast scenario="reminder" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$([System.Security.SecurityElement]::Escape($title))</text>
      <text>$([System.Security.SecurityElement]::Escape($body))</text>
      <text placement="attribution">activity-sync</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Reminder"/>
  <actions>
    <action content="Dismiss" arguments="dismiss" activationType="system"/>
    <action content="Snooze" arguments="snooze" activationType="system"/>
  </actions>
</toast>
"@
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $appId = "Microsoft.Windows.Shell.RunDialog"  # generic, always-registered AppID
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    return $true
  } catch {
    Write-Host "[notify] WinRT toast failed: $($_.Exception.Message)"
    return $false
  }
}

function Show-BalloonTip {
  param($title, $body)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $balloon = New-Object System.Windows.Forms.NotifyIcon
    $balloon.Icon = [System.Drawing.SystemIcons]::Information
    $balloon.BalloonTipTitle = $title
    $balloon.BalloonTipText = $body
    $balloon.Visible = $true
    $balloon.ShowBalloonTip(8000)
    Start-Sleep -Seconds 1   # give the system time to render
    $balloon.Dispose()
    return $true
  } catch {
    Write-Host "[notify] Balloon failed: $($_.Exception.Message)"
    return $false
  }
}

# ── Main ──
$report = Get-LatestReport
if (-not $report) {
  Write-Host "[notify] No reports found in $ReportsDir - nothing to notify."
  exit 0
}

$m = Get-ActionMetrics $report.FullName
$actionable = $m.Failed + $m.FollowUp + $m.NeedsAction
if ($actionable -le 0) {
  Write-Host "[notify] No action items in $($report.Name) - skipping toast."
  exit 0
}

$bits = @()
if ($m.NeedsAction -gt 0) { $bits += "$($m.NeedsAction) need input" }
if ($m.FollowUp    -gt 0) { $bits += "$($m.FollowUp) follow-up$(if ($m.FollowUp -gt 1) {'s'})" }
if ($m.Failed      -gt 0) { $bits += "$($m.Failed) failed" }

$title = "Activity Sync - action needed"
$body  = ($bits -join ", ") + ". Tap to review."

Write-Host "[notify] $title - $body"

# Try strategies in order; stop on first success
if (Show-ToastBurnt -title $title -body $body -reportPath $report.FullName) { exit 0 }
if (Show-ToastWinRT -title $title -body $body)                              { exit 0 }
if (Show-BalloonTip -title $title -body $body)                              { exit 0 }

Write-Host "[notify] All notification strategies failed - see scheduled-run.log"
exit 0   # never fail the sync over a notification

