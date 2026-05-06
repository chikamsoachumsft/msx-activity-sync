# GitHub Copilot SDK — Agent Architecture Patterns

Three patterns for deploying LLM agents using `@github/copilot-sdk`.

---

## 1. SDK ↔ CLI Relationship

The `@github/copilot-sdk` does **not** call a cloud API directly. It spawns the `copilot` CLI as a child process and communicates via JSON-RPC.

```
Your Node.js app
  @github/copilot-sdk  ──JSON-RPC──▶  copilot CLI (child process)
  (CopilotClient)      ◀──JSON-RPC──         │
                                              │ HTTPS
                                              ▼
                                     GitHub Copilot Cloud API (LLM)
```

**Requirement**: `copilot` CLI must be installed and in PATH.

### Three Auth Paths

| Path | Code | How It Works | Best For |
|------|------|-------------|----------|
| **Logged-in user** | `new CopilotClient()` | Reads `~/.copilot/` creds from `copilot auth login` | Local dev, scheduled tasks (same OS user) |
| **GitHub token** | `new CopilotClient({ githubToken: 'ghp_...' })` | Passes PAT to CLI subprocess | CI/CD, GitHub Actions, remote environments |
| **CLI server** | `new CopilotClient({ cliUrl: 'localhost:8080' })` | Connects to already-running CLI via TCP | Shared server, always-on agents |

### Auth Path Details

**Path 1 — Logged-in user (default)**
- You run `copilot auth login` once in a terminal → browser OAuth → token stored in `~/.copilot/`
- SDK spawns CLI subprocess → CLI reads those stored credentials automatically
- Credentials shared across anything running as the same OS user on the same machine
- Risk: if token expires/revoked, need interactive `copilot auth login` again

**Path 2 — GitHub token**
- Pass a PAT with Copilot access scopes directly
- SDK still spawns CLI subprocess, but CLI uses the token instead of `~/.copilot/`
- PATs can be fine-grained (up to 1 year expiry) or classic
- This is how you'd run in CI/CD where there's no interactive login

**Path 3 — CLI server**
- Start CLI as a long-running server: `copilot --server --port 8080`
- SDK does NOT spawn a new CLI — connects to the existing one via TCP
- Multiple SDK clients can share one CLI server
- Auth handled by the server process (via path 1 or 2)

---

## 2. Agent-as-Infrastructure Pattern

Deploy the Copilot CLI as a persistent server on a machine. Multiple SDK clients connect to it.

```
Production Server / VM / Container
┌──────────────────────────────────────────────────┐
│                                                  │
│  copilot --server --port 8080                    │
│  (always running, authenticated, warm)           │
│                                                  │
│  ┌──────────────┐  ┌──────────────┐              │
│  │ MCP Server A │  │ MCP Server B │  ...         │
│  │ (CRM tools)  │  │ (DB tools)   │              │
│  └──────────────┘  └──────────────┘              │
│                                                  │
│  Local filesystem, logs, configs, secrets        │
│  (agent reads + understands all of this)         │
│                                                  │
└──────────────────────┬───────────────────────────┘
                       │ TCP / JSON-RPC
          ┌────────────┼────────────────┐
          ▼            ▼                ▼
    Your app code    Cron jobs     Chat interface
    (SDK client)     (SDK client)  (SDK client)
```

### Key advantages

- **Context is local, not shipped** — agent reads configs, logs, DBs directly instead of you copy-pasting into a prompt
- **Code-triggered, not human-triggered** — any process can open a session (error handlers, monitors, pipelines)
- **Warm startup** — no cold-start overhead; server already running and authenticated
- **Security note**: no TLS on TCP by default — keep behind VPN/SSH tunnel for non-localhost

### Example: auto-remediation triggered by code

```js
// Inside an error handler in production
const client = new CopilotClient({ cliUrl: 'localhost:8080' });
const session = await client.createSession({
  model: 'claude-sonnet-4',
  tools: [diagnosticTools, k8sTools, dbTools],
  onPermissionRequest: approveAll,
});

const diagnosis = await session.sendAndWait({
  prompt: `Pod ${podName} is crash-looping. Check its logs,
           recent deployments, and resource limits.
           Diagnose and fix if safe.`
});
```

No human in the loop. A monitoring system detects an issue, spins up a session, the agent investigates using local tools, and either fixes it or reports back.

---

## 3. Multi-Agent on One Server

One Copilot server, many specialized agents — just different sessions with different tools + system prompts.

```js
// Ops agent
const opsSession = await client.createSession({
  model: 'claude-sonnet-4',
  tools: [kubectlTools, dockerTools, logTools],
  systemMessage: { mode: 'replace', content: opsInstructions },
  onPermissionRequest: approveAll,
});

// Data agent
const dataSession = await client.createSession({
  model: 'gpt-5',
  tools: [sqlTools, etlTools, s3Tools],
  systemMessage: { mode: 'replace', content: dataInstructions },
  onPermissionRequest: approveAll,
});

// CRM agent (what we built)
const crmSession = await client.createSession({
  model: 'claude-sonnet-4',
  tools: [crmTools, workiqTools],
  systemMessage: { mode: 'replace', content: syncInstructions },
  onPermissionRequest: approveAll,
});
```

Each session is independent — different models, different tools, different system prompts. The CLI server handles all concurrently.

### Possible specialized agents

| Agent | Tools (MCP servers) | Trigger |
|-------|-------------------|---------|
| **Ops** | kubectl, docker, log reader | Monitoring alerts |
| **Data** | SQL, ETL pipelines, S3 | Data quality checks |
| **Security** | CVE scanner, Trivy, CodeQL | Vulnerability reports |
| **CRM sync** | msx-crm, WorkIQ | Cron / end-of-day |
| **Incident responder** | PagerDuty, Grafana, shell | Webhook |

### Chat is just another client

A Slack bot, Teams bot, or web UI can connect to the same server. Engineers chat with an agent that's already on the machine, already has context, already has tools wired up.

```
Slack bot → SDK client → cliUrl:8080 → same Copilot server → same local tools
```

---

## Key Insight

**Traditional**: human describes problem → sends context to cloud LLM → gets advice → human executes fix

**Agent-as-infrastructure**: agent IS on the machine → sees problem directly → has tools to act → executes fix (with approval gates for destructive actions)

The performance gain isn't compute speed — it's **context acquisition cost**. An agent on the machine doesn't need you to explain your architecture. It reads it itself.
