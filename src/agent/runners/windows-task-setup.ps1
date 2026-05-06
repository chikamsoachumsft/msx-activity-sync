# Windows Scheduled Task runner for activity-sync
# Creates a daily scheduled task that runs the headless sync at 5 PM CT
#
# Usage:
#   .\windows-task-setup.ps1 -Action Create    # Create the scheduled task
#   .\windows-task-setup.ps1 -Action Remove    # Remove the scheduled task
#   .\windows-task-setup.ps1 -Action Run       # Run once now (for testing)
#   .\windows-task-setup.ps1 -Action Status    # Show task status
#
# Prerequisites:
#   - Node.js installed and on PATH
#   - az CLI logged in (az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47)
#   - This repo cloned locally

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Create', 'Remove', 'Run', 'Status')]
    [string]$Action,

    [string]$Time = '17:00',          # 5 PM local time
    [string]$NodePath = 'node',       # Override if node isn't on PATH
    [switch]$DryRun                   # Pass --dry-run to headless.js
)

$ErrorActionPreference = 'Stop'

$TaskName = 'ActivitySync-CRM'
$TaskDescription = 'Daily CRM activity sync — fetches calendar meetings and creates CRM task activities'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$HeadlessScript = Join-Path $RepoRoot 'src\agent\headless.js'
$LogDir = Join-Path $RepoRoot 'logs'

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force $LogDir | Out-Null
}

function Get-RunArguments {
    $dateStr = (Get-Date).ToString('yyyy-MM-dd')
    $logFile = Join-Path $LogDir "sync-$dateStr.log"
    $args = @($HeadlessScript)
    if ($DryRun) { $args += '--dry-run' }
    return @{
        Arguments = $args -join ' '
        LogFile   = $logFile
    }
}

switch ($Action) {
    'Create' {
        # Check if task already exists
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host "Task '$TaskName' already exists. Use -Action Remove first, or -Action Status to check." -ForegroundColor Yellow
            exit 1
        }

        $runInfo = Get-RunArguments
        $dateStr = '$(Get-Date -Format yyyy-MM-dd)'

        # Build the command that runs headless.js and pipes output to a log file
        # We use PowerShell as the wrapper so we can do log rotation and error handling
        $command = @"
`$logFile = Join-Path '$LogDir' "sync-`$(Get-Date -Format yyyy-MM-dd).log"
`$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'User') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
Set-Location '$RepoRoot'
& '$NodePath' '$HeadlessScript' $(if ($DryRun) { '--dry-run' }) 2>&1 | Tee-Object -FilePath `$logFile -Append
"@

        # Create the trigger (daily at specified time)
        $trigger = New-ScheduledTaskTrigger -Daily -At $Time

        # Create the action (run PowerShell with our command)
        $action = New-ScheduledTaskAction `
            -Execute 'powershell.exe' `
            -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" `
            -WorkingDirectory $RepoRoot

        # Settings: allow running on battery, wake to run, retry on failure
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -RestartCount 2 `
            -RestartInterval (New-TimeSpan -Minutes 5)

        # Register the task (runs as current user)
        Register-ScheduledTask `
            -TaskName $TaskName `
            -Description $TaskDescription `
            -Trigger $trigger `
            -Action $action `
            -Settings $settings `
            -RunLevel Limited

        Write-Host "`nScheduled task '$TaskName' created successfully!" -ForegroundColor Green
        Write-Host "  Schedule: Daily at $Time"
        Write-Host "  Logs:     $LogDir\sync-YYYY-MM-DD.log"
        Write-Host "  Test:     .\windows-task-setup.ps1 -Action Run"
        Write-Host "  Remove:   .\windows-task-setup.ps1 -Action Remove"
    }

    'Remove' {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $existing) {
            Write-Host "Task '$TaskName' not found." -ForegroundColor Yellow
            exit 0
        }

        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Scheduled task '$TaskName' removed." -ForegroundColor Green
    }

    'Run' {
        Write-Host "Running activity sync now..." -ForegroundColor Cyan
        $dateStr = (Get-Date).ToString('yyyy-MM-dd')
        $logFile = Join-Path $LogDir "sync-$dateStr.log"

        Set-Location $RepoRoot
        $extraArgs = @($HeadlessScript)
        if ($DryRun) { $extraArgs += '--dry-run' }

        & $NodePath @extraArgs 2>&1 | Tee-Object -FilePath $logFile -Append
        Write-Host "`nLog saved to: $logFile" -ForegroundColor Gray
    }

    'Status' {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $existing) {
            Write-Host "Task '$TaskName' not found." -ForegroundColor Yellow
            exit 0
        }

        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "`nTask: $TaskName" -ForegroundColor Cyan
        Write-Host "  State:        $($existing.State)"
        Write-Host "  Last Run:     $($info.LastRunTime)"
        Write-Host "  Last Result:  $($info.LastTaskResult)"
        Write-Host "  Next Run:     $($info.NextRunTime)"

        # Show recent logs
        $recentLogs = Get-ChildItem $LogDir -Filter 'sync-*.log' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 3

        if ($recentLogs) {
            Write-Host "`n  Recent logs:"
            foreach ($log in $recentLogs) {
                $size = '{0:N1} KB' -f ($log.Length / 1KB)
                Write-Host "    $($log.Name) ($size)"
            }
        }
    }
}
