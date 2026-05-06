#requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for activity-sync on a new user's machine.
.DESCRIPTION
  - Verifies prerequisites (Node, Azure CLI, gh CLI)
  - Runs `npm install` in the repo
  - Logs in to Azure (if not already)
  - Smoke-tests Azure VPN dial
  - Optionally creates a private GitHub repo for sync logs
  - Stages catchup.js + scheduled-run.cmd into %USERPROFILE%\.activity-sync
  - Creates Windows scheduled task with WakeToRun + StartWhenAvailable
.PARAMETER VpnName
  Name of the Windows VPN profile to dial. Default: MSFT-AzVPN-Manual.
.PARAMETER Tenant
  Azure tenant ID. Default: Microsoft (72f988bf-...).
.PARAMETER ScheduleTime
  HH:mm of the daily run. Default: 16:15.
.PARAMETER LogsRepo
  GitHub repo for log push, format owner/name. Skip prompt if specified.
.PARAMETER NoLogsRepo
  Skip the logs repo creation entirely (local-only mode).
.EXAMPLE
  .\install\setup.ps1
.EXAMPLE
  .\install\setup.ps1 -NoLogsRepo
#>
[CmdletBinding()]
param(
  [string]$VpnName = "MSFT-AzVPN-Manual",
  [string]$Tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47",
  [string]$ScheduleTime = "16:15",
  [string]$LogsRepo,
  [switch]$NoLogsRepo
)

$ErrorActionPreference = "Stop"
function Step($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[X] $msg" -ForegroundColor Red; exit 1 }

# ─── 0. Locate repo root ───────────────────────────────────────────────
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Templates = Join-Path $PSScriptRoot "templates"
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
  Fail "Could not find package.json. Run setup.ps1 from the cloned repo's install folder."
}
Ok "Repo root: $RepoRoot"

# ─── 1. Prerequisites ──────────────────────────────────────────────────
Step "Checking prerequisites"
foreach ($cmd in 'node','npm','az','gh','git') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Fail "Missing required tool: $cmd. Install it and re-run."
  }
}
$nodeMajor = [int]((node -v).Substring(1).Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node 20+ required (found $(node -v))" }
$NodeExe = (Get-Command node).Source
Ok "Node $(node -v), npm $(npm -v), az $(az version --query '\"azure-cli\"' -o tsv), gh detected"

# ─── 2. npm install ────────────────────────────────────────────────────
Step "Installing dependencies (npm install)"
Push-Location $RepoRoot
try { npm install --silent 2>&1 | Out-Null; Ok "Dependencies installed" }
finally { Pop-Location }

# ─── 3. Azure CLI auth ─────────────────────────────────────────────────
Step "Verifying Azure CLI authentication"
$account = az account show --query "{user:user.name,tenant:tenantId}" -o json 2>$null | ConvertFrom-Json
if (-not $account -or $account.tenant -ne $Tenant) {
  Warn "Not logged in to tenant $Tenant. Launching browser..."
  az login --tenant $Tenant | Out-Null
  $account = az account show --query "{user:user.name,tenant:tenantId}" -o json | ConvertFrom-Json
}
Ok "Azure CLI logged in as $($account.user)"

# ─── 4. VPN smoke test ─────────────────────────────────────────────────
Step "Testing VPN profile '$VpnName'"
$vpn = Get-VpnConnection -Name $VpnName -ErrorAction SilentlyContinue
if (-not $vpn) {
  Warn "VPN profile '$VpnName' not found. The sync will run but may hit IP block on CRM."
  Warn "Add the VPN profile via Settings → Network → VPN, then re-run setup."
} else {
  rasdial $VpnName | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Ok "VPN dial succeeded — disconnecting"
    rasdial $VpnName /disconnect | Out-Null
  } else {
    Warn "VPN dial returned non-zero. Sync may need manual VPN connection."
  }
}

# ─── 5. State dir + config ─────────────────────────────────────────────
Step "Setting up state directory"
$StateDir = Join-Path $env:USERPROFILE ".activity-sync"
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
Copy-Item (Join-Path $Templates "catchup.js") (Join-Path $StateDir "catchup.js") -Force
Copy-Item (Join-Path $Templates "scheduled-run.cmd") (Join-Path $StateDir "scheduled-run.cmd") -Force

@"
REPO_PATH=$RepoRoot
VPN_NAME=$VpnName
NODE_EXE=$NodeExe
"@ | Set-Content (Join-Path $StateDir "config.env") -Encoding ASCII

if (-not (Test-Path (Join-Path $StateDir "last-run-date.txt"))) {
  (Get-Date).ToString("yyyy-MM-dd") | Set-Content (Join-Path $StateDir "last-run-date.txt") -NoNewline
}
Ok "State staged at $StateDir"

# ─── 6. Logs repo (optional) ───────────────────────────────────────────
if ($NoLogsRepo) {
  Warn "Skipping logs repo (NoLogsRepo flag). Reports stay in $RepoRoot\reports\"
} else {
  Step "Setting up reports GitHub repo"
  $ghStatus = gh auth status 2>&1
  if ($LASTEXITCODE -ne 0) {
    Warn "gh CLI not authenticated. Run: gh auth login"
    $skip = Read-Host "Skip logs repo? (y/N)"
    if ($skip -ne 'y') { Fail "Re-run setup after authenticating gh" }
  } else {
    $ghUser = (gh api user -q .login)
    if (-not $LogsRepo) { $LogsRepo = "$ghUser/activity-sync-logs" }

    $exists = $false
    gh repo view $LogsRepo 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $exists = $true }

    if (-not $exists) {
      Step "Creating private repo $LogsRepo"
      gh repo create $LogsRepo --private --description "Personal CRM activity sync logs (auto-pushed)" --confirm | Out-Null
      Ok "Created github.com/$LogsRepo (private)"
    } else {
      Ok "Repo $LogsRepo already exists"
    }

    $ReportsRepo = Join-Path $StateDir "reports-repo"
    if (-not (Test-Path (Join-Path $ReportsRepo ".git"))) {
      if (Test-Path $ReportsRepo) { Remove-Item $ReportsRepo -Recurse -Force }
      git clone "https://github.com/$LogsRepo" $ReportsRepo 2>&1 | Out-Null

      $userName = (git config --global user.name)
      if (-not $userName) { $userName = $ghUser }
      git -C $ReportsRepo config user.name $userName
      git -C $ReportsRepo config user.email "$ghUser@users.noreply.github.com"

      $remoteEmpty = -not (git -C $ReportsRepo log -1 --oneline 2>$null)
      if ($remoteEmpty) {
        New-Item -ItemType Directory -Path (Join-Path $ReportsRepo "reports") -Force | Out-Null
        "ignored locally" | Set-Content (Join-Path $ReportsRepo "reports\.gitkeep")
        "# Activity Sync Logs`n`n_Pending first run._" | Set-Content (Join-Path $ReportsRepo "README.md")
        git -C $ReportsRepo add . 2>&1 | Out-Null
        git -C $ReportsRepo commit -m "Initial commit" --quiet 2>&1 | Out-Null
        git -C $ReportsRepo push --quiet 2>&1 | Out-Null
      }
      Ok "Reports-repo cloned at $ReportsRepo"
    } else {
      Ok "Reports-repo already initialized"
    }
  }
}

# ─── 7. First run (validate everything works) ─────────────────────────
Step "Running a one-time test sync to validate the full pipeline"
Write-Host ""
Write-Host "    This will: dial VPN -> sync calendar -> create CRM tasks -> push log to GitHub"
Write-Host "    Estimated time: 2-5 minutes"
Write-Host ""
$run = Read-Host "Run test sync now? [Y/n]"
$testRanOk = $false
if ($run -ne 'n' -and $run -ne 'N') {
  Step "Running $StateDir\scheduled-run.cmd ..."
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList '/c',"`"$StateDir\scheduled-run.cmd`"" -NoNewWindow -PassThru -Wait
  if ($proc.ExitCode -eq 0) {
    Ok "Test sync completed successfully (exit 0)"
    $testRanOk = $true
    if (-not $NoLogsRepo -and $LogsRepo) {
      Ok "Check your logs repo: https://github.com/$LogsRepo"
    }
  } else {
    Warn "Test sync exited with code $($proc.ExitCode). Check log:"
    Write-Host "    Get-Content `"$StateDir\scheduled-run.log`" -Tail 60"
  }
} else {
  Warn "Skipped test run."
}

# ─── 8. Scheduled task ─────────────────────────────────────────────────
Write-Host ""
Step "Set up automatic daily schedule?"
Write-Host ""
Write-Host "    Creates a Windows scheduled task that runs the sync at $ScheduleTime"
Write-Host "    every weekday. The laptop will be woken from sleep if needed."
Write-Host ""
if (-not $testRanOk) {
  Warn "The test sync did not succeed. You can still install the schedule, but"
  Warn "fix the underlying issue first or it will keep failing automatically."
}
$installSched = Read-Host "Install scheduled task now? [Y/n]"
if ($installSched -eq 'n' -or $installSched -eq 'N') {
  Warn "Skipped scheduled task. To install later, re-run setup.ps1."
  $taskName = $null
} else {
  $taskName = "ActivitySync-DailyRun"
  schtasks /Query /TN $taskName 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Warn "Task already exists - recreating"
    schtasks /Delete /TN $taskName /F | Out-Null
  }

  # Create base task
  schtasks /Create /TN $taskName `
    /TR "`"$StateDir\scheduled-run.cmd`"" `
    /SC WEEKLY /D MON,TUE,WED,THU,FRI `
    /ST $ScheduleTime /F | Out-Null

  # Inject WakeToRun + StartWhenAvailable + AllowOnBatteries via XML
  $xmlPath = Join-Path $env:TEMP "activitysync-task.xml"
  schtasks /Query /TN $taskName /XML | Out-File $xmlPath -Encoding Unicode
  $content = Get-Content $xmlPath -Raw
  $content = $content `
    -replace '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>','<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>' `
    -replace '<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>',"<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`r`n    <WakeToRun>true</WakeToRun>`r`n    <StartWhenAvailable>true</StartWhenAvailable>"
  Set-Content $xmlPath $content -Encoding Unicode
  schtasks /Create /TN $taskName /XML $xmlPath /F | Out-Null
  Ok "Scheduled task registered for $ScheduleTime weekdays (WakeToRun=true)"
}

Write-Host ""
Write-Host "===================================================" -ForegroundColor Green
Write-Host " [OK] Setup complete!" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
Write-Host ""
if ($taskName) {
  Write-Host " - Schedule:    $ScheduleTime weekdays (auto-wakes laptop)"
}
Write-Host " - Repo path:   $RepoRoot"
Write-Host " - State dir:   $StateDir"
if (-not $NoLogsRepo -and $LogsRepo) {
  Write-Host " - Logs repo:   https://github.com/$LogsRepo"
}
if ($taskName) {
  Write-Host " - Manual run:  schtasks /Run /TN $taskName"
}
Write-Host " - Live log:    Get-Content `"$StateDir\scheduled-run.log`" -Tail 30 -Wait"
Write-Host ""

