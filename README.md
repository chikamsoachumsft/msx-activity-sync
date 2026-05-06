# MSX Activity Sync

**Stop manually logging customer meetings in MSX CRM.** This agent reads your Outlook calendar, figures out which meetings belong to which opportunity milestones, and creates the matching CRM tasks for you — automatically, every weekday.

## What you get

- 🗓️ **Calendar → CRM, hands-off.** Customer meetings become CRM task activities on the right milestone.
- 🤖 **Smart matching.** An LLM classifier (WorkIQ MCP) maps meeting subjects/attendees to the correct opportunity + milestone. Falls back gracefully if the model is unavailable.
- ⏰ **Runs unattended.** Windows Task Scheduler fires it at 4:15 PM on weekdays, wakes the laptop if asleep, dials the VPN automatically, runs even on battery.
- 🔁 **Catches up missed days.** Out sick? Plane mode? The next run backfills weekdays you missed.
- �️ **Won't double-log.** Before creating a task, the agent checks CRM for any existing task on the same milestone that day — including ones you logged manually — and skips. Duplicates are surfaced in the report and the live log so you can verify.
- �📊 **Personal log archive.** Every run pushes a markdown report + auto-updated README to your own private GitHub repo so you can see what got synced.
- 🔒 **No secrets stored.** Auth via `az login` + Windows VPN profile. You own the data, the logs, and the schedule.

---

## ⚡ Set it up in 3 commands

> Requires: **Windows**, **Node 20+**, **Azure CLI** (`az`), **GitHub CLI** (`gh`), **Git**, and the **MSFT-AzVPN-Manual** VPN profile installed.

```powershell
git clone https://github.com/chikamsoachumsft/msx-activity-sync.git
cd msx-activity-sync
.\install\setup.ps1
```

The setup script will walk you through it interactively:

1. ✅ Checks prerequisites (Node, az, gh, git)
2. ✅ Runs `npm install`
3. ✅ Logs you into Azure (`az login`) if needed
4. ✅ Tests your VPN dial
5. ✅ Creates a private `<your-user>/activity-sync-logs` repo for run reports
6. ✅ **Runs a test sync** — validates the full pipeline end-to-end
7. ✅ **Registers the daily schedule** — only after you confirm the test worked

That's it. After setup, you don't have to do anything — meetings will sync every weekday at 4:15 PM and reports will appear in your logs repo.

### Setup flags

```powershell
.\install\setup.ps1 -NoLogsRepo                  # local-only, no GitHub publishing
.\install\setup.ps1 -ScheduleTime 09:00          # different daily time
.\install\setup.ps1 -VpnName "OtherVPN"          # different VPN profile
.\install\setup.ps1 -LogsRepo "you/some-repo"    # use an existing repo
```

---

## How it works

For each working day in the sync window:

1. Fetches your Outlook calendar (Microsoft Graph)
2. Classifies each meeting → which opportunity / milestone it belongs to (LLM via the WorkIQ MCP, with fallbacks)
3. Stages CRM write operations (create task, close task, link to milestone)
4. Executes the staged ops through the MSX CRM MCP
5. Writes a `reports/sync_<window>.md` summary
6. Publishes the latest report + a refreshed `README.md` to your private logs repo

If your machine was asleep or VPN-disconnected when the schedule fired, the next run catches up missed weekdays automatically.

---

## Prerequisites (in detail)

| Tool | Why | Install |
|------|-----|---------|
| Node 20+ | Runtime | https://nodejs.org |
| Azure CLI | Token broker for CRM auth | `winget install Microsoft.AzureCLI` |
| GitHub CLI (`gh`) | Auto-creates your private logs repo | `winget install GitHub.cli` |
| Git | Pushing reports | `winget install Git.Git` |
| `MSFT-AzVPN-Manual` | Corporate VPN (P2S, cert auth — dials unattended) | Settings → Network → VPN |

> **Why this VPN specifically?** Only `MSFT-AzVPN-Manual` (Azure Point-to-Site, cert auth) can dial without an interactive MFA prompt, which the scheduled task needs. `MSFTVPN-Manual` (EAP/MFA) won't work for unattended runs.

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │  Windows Task Scheduler      │
                    │  (4:15 PM weekdays,          │
                    │   WakeToRun=true)            │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  scheduled-run.cmd           │
                    │  - rasdial MSFT-AzVPN-Manual │
                    │  - node catchup.js           │
                    │  - node post-run-summary.js  │
                    │  - rasdial /disconnect       │
                    └──────────────┬───────────────┘
                                   │
            ┌──────────────────────┼─────────────────────────┐
            ▼                      ▼                         ▼
     ┌────────────┐         ┌────────────┐          ┌────────────────┐
     │ MS Graph   │         │ WorkIQ MCP │          │ MSX CRM MCP    │
     │ (calendar) │         │ (classify) │          │ (read + write) │
     └────────────┘         └────────────┘          └────────────────┘
                                                            │
                                                            ▼
                                                    ┌──────────────┐
                                                    │ <you>/       │
                                                    │ activity-    │
                                                    │ sync-logs    │
                                                    │ (private GH) │
                                                    └──────────────┘
```

**Per-user state** lives in `%USERPROFILE%\.activity-sync\`:

```
.activity-sync\
  catchup.js              # decides which dates to sync
  scheduled-run.cmd       # entry point (VPN + sync + publish)
  config.env              # REPO_PATH, VPN_NAME, NODE_EXE
  last-run-date.txt       # high-water mark
  scheduled-run.log       # rolling stdout/stderr
  reports-repo\           # local clone of your private logs repo
```

Nothing is hardcoded to one user — every path is resolved from `%USERPROFILE%` or `config.env`.

---

## How runs reach GitHub

After each sync, [tools/post-run-summary.js](tools/post-run-summary.js):

1. Picks the most recent `reports/sync_*.md` from the source repo
2. Copies it into `<state>\reports-repo\reports\`
3. Regenerates `README.md` with metrics (created, closed, failed counts) from the latest run
4. `git commit && git push` to your private `activity-sync-logs` repo

The push is best-effort — a network blip won't fail the sync. Your `README.md` is overwritten on every run so it always reflects the latest status; the `reports/` folder accumulates history.

---

## Day-to-day usage

```powershell
# Run on demand
schtasks /Run /TN ActivitySync-DailyRun

# Tail the live log
Get-Content "$env:USERPROFILE\.activity-sync\scheduled-run.log" -Tail 30 -Wait

# View past runs
start https://github.com/<you>/activity-sync-logs

# Run a specific date range manually (no schedule, no publish)
node src/agent/cli.js sync --from 2026-05-01 --to 2026-05-06
```

### Pause / resume the schedule

```powershell
schtasks /Change /TN ActivitySync-DailyRun /DISABLE
schtasks /Change /TN ActivitySync-DailyRun /ENABLE
```

### Uninstall

```powershell
schtasks /Delete /TN ActivitySync-DailyRun /F
Remove-Item "$env:USERPROFILE\.activity-sync" -Recurse -Force
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `rasdial` returns non-zero | VPN profile missing or wrong name | Add `MSFT-AzVPN-Manual` from corp portal, or pass `-VpnName` |
| CRM returns 401 / IP block | VPN didn't connect | Check `scheduled-run.log` for the `rasdial` output |
| `az` token timeout | Corporate proxy slow | Already bumped to 90s in `src/auth.js`; further bump if needed |
| WorkIQ classification fails | Service hiccup | Sync still completes via fallback classifier; check next run |
| Schedule didn't fire overnight | Laptop was on battery | `StopIfGoingOnBatteries=false` is set; verify with `schtasks /Query /TN ActivitySync-DailyRun /XML` |
| Push to logs repo fails | `gh auth` expired | Run `gh auth login` |

Everything is in `%USERPROFILE%\.activity-sync\scheduled-run.log` — start there.

---

## Files at a glance

| Path | What it is |
|------|------------|
| [install/setup.ps1](install/setup.ps1) | One-command onboarding |
| [install/templates/scheduled-run.cmd](install/templates/scheduled-run.cmd) | Portable scheduled-task entry point |
| [install/templates/catchup.js](install/templates/catchup.js) | Decides which dates to sync, runs them |
| [src/agent/sync.js](src/agent/sync.js) | Core sync engine (calendar → classify → CRM ops) |
| [src/agent/classifier.js](src/agent/classifier.js) | LLM classifier (WorkIQ + fallback) |
| [src/agent/cli.js](src/agent/cli.js) | Manual CLI (`sync`, `auth`, etc.) |
| [tools/post-run-summary.js](tools/post-run-summary.js) | Publishes report → private GH repo |
| [reports/](reports/) | Local run history (gitignored in this repo) |

---

## Related

- The MCP servers this agent depends on (MSX CRM, WorkIQ): [docs/MCP_SERVER.md](docs/MCP_SERVER.md).
- Architecture notes for the MCP server itself: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
