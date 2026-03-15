# lossless-claw

Lossless Context Management plugin for [OpenClaw](https://github.com/openclaw/openclaw), based on the [LCM paper](https://papers.voltropy.com/LCM). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Ozempic — Context Management Layer](#ozempic--context-management-layer)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## What it does

Two ways to learn: read the below, or [check out this super cool animated visualization](https://losslesscontext.ai).

When a conversation grows beyond the model's context window, OpenClaw (just like all of the other agents) normally truncates older messages. LCM instead:

1. **Persists every message** in a SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) so agents can search and recall details from compacted history

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

**It feels like talking to an agent that never forgets. Because it doesn't. In normal operation, you'll never need to think about compaction again.**

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

### Install the plugin

Use OpenClaw's plugin installer (recommended):

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

If you're running from a local OpenClaw checkout, use:

```bash
pnpm openclaw plugins install @martian-engineering/lossless-claw
```

For local plugin development, link your working copy instead of copying files:

```bash
openclaw plugins install --link /path/to/lossless-claw
# or from a local OpenClaw checkout:
# pnpm openclaw plugins install --link /path/to/lossless-claw
```

The install command records the plugin, enables it, and applies compatible slot selection (including `contextEngine` when applicable).

### Configure OpenClaw

In most cases, no manual JSON edits are needed after `openclaw plugins install`.

If you need to set it manually, ensure the context engine slot points at lossless-claw:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "lossless-claw"
    }
  }
}
```

Restart OpenClaw after configuration changes.

## Configuration

LCM is configured through a combination of plugin config and environment variables. Environment variables take precedence for backward compatibility.

### Plugin config

Add a `lossless-claw` entry under `plugins.entries` in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "enabled": true,
        "config": {
          "freshTailCount": 32,
          "contextThreshold": 0.75,
          "incrementalMaxDepth": -1
        }
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0–1.0) |
| `LCM_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `LCM_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `LCM_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `LCM_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes (0 = leaf only, -1 = unlimited) |
| `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction chunk |
| `LCM_LEAF_TARGET_TOKENS` | `1200` | Target token count for leaf summaries |
| `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target token count for condensed summaries |
| `LCM_MAX_EXPAND_TOKENS` | `4000` | Token cap for sub-agent expansion queries |
| `LCM_LARGE_FILE_TOKEN_THRESHOLD` | `25000` | File blocks above this size are intercepted and stored separately |
| `LCM_LARGE_FILE_SUMMARY_PROVIDER` | `""` | Provider override for large-file summarization |
| `LCM_LARGE_FILE_SUMMARY_MODEL` | `""` | Model override for large-file summarization |
| `LCM_SUMMARY_MODEL` | *(from OpenClaw)* | Model for summarization (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `LCM_SUMMARY_PROVIDER` | *(from OpenClaw)* | Provider override for summarization |
| `LCM_AUTOCOMPACT_DISABLED` | `false` | Disable automatic compaction after turns |
| `LCM_PRUNE_HEARTBEAT_OK` | `false` | Retroactively delete `HEARTBEAT_OK` turn cycles from LCM storage |

### Recommended starting configuration

```
LCM_FRESH_TAIL_COUNT=32
LCM_INCREMENTAL_MAX_DEPTH=-1
LCM_CONTEXT_THRESHOLD=0.75
```

- **freshTailCount=32** protects the last 32 messages from compaction, giving the model enough recent context for continuity.
- **incrementalMaxDepth=-1** enables unlimited automatic condensation after each compaction pass — the DAG cascades as deep as needed. Set to `0` (default) for leaf-only, or a positive integer for a specific depth cap.
- **contextThreshold=0.75** triggers compaction when context reaches 75% of the model's window, leaving headroom for the model's response.

### OpenClaw session reset settings

LCM preserves history through compaction, but it does **not** change OpenClaw's core session reset policy. If sessions are resetting sooner than you want, increase OpenClaw's `session.reset.idleMinutes` or use a channel/type-specific override.

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

- `session.reset.mode: "idle"` keeps a session alive until the idle window expires.
- `session.reset.idleMinutes` is the actual reset interval in minutes.
- OpenClaw does **not** currently enforce a maximum `idleMinutes`; in source it is validated only as a positive integer.
- If you also use daily reset mode, `idleMinutes` acts as a secondary guard and the session resets when **either** the daily boundary or the idle window is reached first.
- Legacy `session.idleMinutes` still works, but OpenClaw prefers `session.reset.idleMinutes`.

Useful values:

- `1440` = 1 day
- `10080` = 7 days
- `43200` = 30 days
- `525600` = 365 days

For most long-lived LCM setups, a good starting point is:

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

## Documentation

- [Ozempic — Context Management Layer](#ozempic--context-management-layer)
- [Configuration guide](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Agent tools](docs/agent-tools.md)
- [TUI Reference](docs/tui.md)
- [lcm-tui](tui/README.md)
- [Optional: enable FTS5 for fast full-text search](docs/fts5.md)

## Ozempic — Context Management Layer

Ozempic is a set of context management features built into lossless-claw. Its job is to give locally-run, small-context-window language models a fighting chance at long-lived, tool-heavy agent sessions. The design goal is an agent that never needs `/new` or manual session reset, has a small organized context containing only what it needs for the current turn, and can recall historical context from the DAG on demand.

All features are independently toggleable. Sensible defaults work for any agent without configuration.

### Tier 1 — Engine features

Core context management mechanics. Always beneficial. Configured in `plugins.entries.lossless-claw.config`.

| Feature | Config key | Default | Description |
|---------|-----------|---------|-------------|
| Pre-assembly pressure loop | `pressureLoop` | `true` | Runs compaction passes before assembly when context exceeds budget, rather than discovering the problem after |
| Pressure max passes | `pressureMaxPasses` | `3` | Maximum compaction passes in the pressure loop |
| Fresh tail trimming | `freshTailTrimUnderPressure` | `true` | Trims oldest fresh-tail messages instead of overflowing when the tail alone exceeds the token budget |
| Provenance typing | `provenanceTyping` | `true` | Classifies tool results as `observed`, `computed`, or `mutation` based on tool name and content |
| Provenance-aware eviction | `provenanceEviction` | `true` | Evicts stale `observed` results after a `mutation` to the same resource |

### Tier 2 — Heuristic features

Domain-agnostic heuristics that improve context quality. Configured in `plugins.entries.lossless-claw.config`.

| Feature | Config key | Default | Description |
|---------|-----------|---------|-------------|
| Acknowledgment pruning | `ackPruning` | `false` | Removes low-value conversational exchanges ("ok thanks" / "You're welcome!") from assembled context |
| Ack pruning threshold | `ackPruningMaxTokens` | `30` | Messages under this token count with no tool calls are ack candidates |
| Summary inclusion mode | `summaryMode` | `"auto"` | `"always"` = include summaries, `"on-demand"` = exclude (use recall tools), `"auto"` = include when under 50% budget |
| Tool result size cap | `toolResultCap` | `400` | Truncates individual tool results exceeding this token count. `0` = unlimited |
| Reasoning trace handling | `reasoningTraceMode` | `"drop"` | `"drop"` = remove previous-turn reasoning traces, `"keep"` = preserve them |

### Tier 3 — Agent-specific policies

Powerful features that require per-agent configuration. Defined in `context-policy.json` in the agent's workspace directory (e.g., `~/.openclaw/workspace-timetrack/context-policy.json`). All off by default.

#### Tool result compaction rules

Extract specific fields from tool results instead of blind truncation. For example, keep only `day`, `start`, `end`, and `total` from a spreadsheet read:

```json
{
  "toolResultCompaction": {
    "rules": [
      {
        "toolNamePattern": "sheets_cli.py.*read",
        "extractFields": ["day", "start", "end", "total"],
        "maxTokens": 150
      }
    ]
  }
}
```

#### Custom tool classification

Override the heuristic provenance classifier with explicit tool-to-provenance mappings:

```json
{
  "toolClassification": {
    "observed": ["read-day", "read-week", "metadata"],
    "computed": ["calc", "aggregate-days"],
    "mutation": ["write-row", "set-day-shift"]
  }
}
```

#### Freshness TTL

Time-based eviction for `observed` results, even without a subsequent `mutation`:

```json
{
  "freshnessTtl": {
    "default": 300,
    "byTool": { "get-quote": 30, "read-day": 300 }
  }
}
```

#### Session state document

A small structured working memory document updated after mutation-provenance turns and injected into the assembled context. Provides the model with a concise, always-current snapshot of domain state — replacing hundreds of tokens of summary archaeology with 50–200 tokens of structured truth.

**What the model sees in context:**

```
[Session State]
Active sheet: March 2026
PTO balance: 7.5 hours
Last operation: updated March 24 to 8:30 AM - 3:00 PM
Known anomalies: day 24 appears twice (rows 23 and 31)
Notes: User prefers 24-hour time format

[Recent Activity]  — lcm_grep("<timestamp or keyword>") for full context
2:30 PM — Updated March 24 clock-out to 3:00 PM
2:15 PM — Read March 23 (8:30 AM - 5:00 PM, confirmed correct)
1:50 PM — Updated PTO balance from 8.0 to 7.5 hours
```

The activity log timestamps match the format used in DAG summaries (same timezone), so the model can cross-reference entries with summaries and use `lcm_grep` to drill into any entry for full detail. This turns the activity log into a temporal index — the model scans the log, decides if the one-liner is enough context, and only calls recall tools when it needs depth.

**Configuration:**

```json
{
  "sessionState": {
    "enabled": true,
    "maxTokens": 300,
    "format": "hybrid",
    "updateOn": "mutation",
    "schema": {
      "fields": [
        {"name": "activeSheet", "label": "Active sheet"},
        {"name": "ptoBalance", "label": "PTO balance"},
        {"name": "lastOperation", "label": "Last operation"},
        {"name": "knownAnomalies", "label": "Known anomalies"}
      ]
    },
    "activityLog": {
      "enabled": true,
      "maxEntries": 10,
      "recallHint": true
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable session state |
| `maxTokens` | integer | `300` | Hard cap on state doc tokens; subtracted from assembly budget |
| `format` | string | `"hybrid"` | `"structured"` = named fields only, `"hybrid"` = named fields + freeform `_notes` |
| `updateOn` | string | `"mutation"` | `"mutation"` = update after mutations only, `"any-tool"` = update after any tool call |
| `schema.fields` | array | `[]` | Field definitions: `name` (JSON key), `label` (rendered in context), optional `description` (hint to update model about what belongs in the field) |
| `activityLog.enabled` | boolean | `true` | Rolling activity log with timestamps |
| `activityLog.maxEntries` | integer | `10` | Max log entries before oldest rolls off |
| `activityLog.recallHint` | boolean | `true` | Add `lcm_grep(...)` hint in log header |
| `model` | string | *(summaryModel)* | Primary model for session state updates — separates it from compaction on the same model |
| `provider` | string | *(summaryProvider)* | Provider for the primary session state model |
| `thinkingEnabled` | boolean | `false` | Enable extended thinking for the session state model (recommended for small models doing complex field extraction) |
| `fallbackModel` | string | — | Fallback model used when the primary is busy with compaction (compaction-aware router) |
| `fallbackProvider` | string | — | Provider for the fallback model |
| `routingEnabled` | boolean | `true` | Enable/disable compaction-aware routing. When `true` (default) and a fallback model is configured, session state calls route to the fallback whenever compaction is in flight. Set to `false` to always use the primary model (updates may queue behind compaction) or to temporarily disable routing without removing the fallback config |

The state document is persisted to the LCM SQLite database and survives gateway restarts. Updates are fail-open — if the summary model returns garbage, the previous state is kept.

### Compaction-aware routing (poor man's router)

When running multiple local models, compaction and session state updates can contend for the same GPU. The compaction-aware router solves this by detecting when compaction is in flight and routing session state calls to a fallback model instead.

**How it works:**

1. The engine tracks a `compactionInFlight` counter, incremented when any compaction pass starts and decremented when it finishes.
2. When `maybeUpdateSessionState` fires, it checks the counter:
   - Counter is 0 (compaction idle) → use the primary model (`model`/`provider`)
   - Counter > 0 (compaction running) → use the fallback model (`fallbackModel`/`fallbackProvider`)
3. If the counter > 0 and no fallback is configured, the session state update is **skipped** for that turn (fail-open — better than queuing behind a 60-120s compaction call).

**Recommended setup for a three-model cluster:**

```json
{
  "sessionState": {
    "provider": "mac-mini-9b",
    "model": "Qwen3.5-9B",
    "fallbackProvider": "mac-studio-4b",
    "fallbackModel": "Qwen3.5-4B",
    "routingEnabled": true
  }
}
```

This keeps compaction (always 9B) and session state (9B when free, 4B when 9B is busy) separated from the main inference model. The 4B fallback handles the edge case where compaction and a session state update would otherwise collide.

**To disable routing** without removing the fallback config: set `"routingEnabled": false`. Session state calls will always go to the primary model. If that model is busy with compaction, the update will queue or timeout (30s backstop).

**To disable session state when primary is busy** without a fallback: omit `fallbackModel`. The engine will skip the update when compaction is in flight.

### Model tuning recommendations

Three-model setup (main inference + compaction + session state):

| Model role | Recommended settings | Why |
|------------|---------------------|-----|
| **Main inference** (27B+) | `temperature: 0.6`, `top_p: 0.95`, `min_p: 0.05` | Thinking handles structured reasoning; slight temperature keeps responses natural |
| **Compaction/summarization** (9B) | `temperature: 0`, `top_p: 1.0`, thinking off | Summaries should be deterministic and faithful — zero temperature, no creativity |
| **Session state** (4B) | `temperature: 0.5` with thinking on, or `temperature: 0` without | Thinking benefits from exploration; the strict JSON prompt constrains the output regardless |

With thinking enabled on the session state model (`"thinkingEnabled": true` in context-policy.json), lossless-claw automatically uses `temperature: 0.5` for that call. All other model parameters (`top_p`, `min_p`, `repetition_penalty`) are controlled by your provider's server configuration.

### Context manifests

On every assembly, Ozempic writes a manifest file recording exactly what went into the model prompt. Manifests are written to `~/.openclaw/aeon/manifests/<sessionId>.latest.json` and include provenance metadata, Ozempic feature flags, and assembly statistics. They are a forensic/debugging tool — the model never sees them.

### Configuration example

A complete Ozempic configuration for a timetrack agent:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "config": {
          "freshTailCount": 8,
          "contextThreshold": 0.40,
          "pressureLoop": true,
          "pressureMaxPasses": 3,
          "freshTailTrimUnderPressure": true,
          "provenanceTyping": true,
          "provenanceEviction": true,
          "summaryMode": "auto",
          "toolResultCap": 400,
          "reasoningTraceMode": "drop",
          "ackPruning": false,
          "ackPruningMaxTokens": 30
        }
      }
    }
  }
}
```

With a per-agent policy in `~/.openclaw/workspace-timetrack/context-policy.json`:

```json
{
  "overrides": {
    "summaryMode": "on-demand",
    "toolResultCap": 200,
    "ackPruning": true
  },
  "sessionState": {
    "enabled": true,
    "maxTokens": 300,
    "format": "hybrid",
    "updateOn": "mutation",
    "schema": {
      "fields": [
        {"name": "activeSheet", "label": "Active sheet"},
        {"name": "ptoBalance", "label": "PTO balance"},
        {"name": "lastOperation", "label": "Last operation"},
        {"name": "knownAnomalies", "label": "Known anomalies"}
      ]
    },
    "activityLog": {
      "enabled": true,
      "maxEntries": 10,
      "recallHint": true
    }
  },
  "toolClassification": {
    "observed": ["read-day", "read-week", "metadata"],
    "mutation": ["write-row", "set-day-shift"]
  },
  "freshnessTtl": {
    "default": 300
  }
}
```

For the full design document, see [Ozempic v2 plan](../ozempic_v2_plan.md).

## Development

```bash
# Run tests
npx vitest

# Type check
npx tsc --noEmit

# Run a specific test file
npx vitest test/engine.test.ts
```

### Project structure

```
index.ts                    # Plugin entry point and registration
src/
  engine.ts                 # LcmContextEngine — implements ContextEngine interface
  assembler.ts              # Context assembly (summaries + messages → model context)
  compaction.ts             # CompactionEngine — leaf passes, condensation, sweeps
  summarize.ts              # Depth-aware prompt generation and LLM summarization
  context-manifest.ts       # Provenance types, manifest schema, and file writer
  context-policy.ts         # Per-agent policy loader and Tier 3 feature logic
  session-state.ts          # Session state persistence and update logic
  retrieval.ts              # RetrievalEngine — grep, describe, expand operations
  expansion.ts              # DAG expansion logic for lcm_expand_query
  expansion-auth.ts         # Delegation grants for sub-agent expansion
  expansion-policy.ts       # Depth/token policy for expansion
  large-files.ts            # File interception, storage, and exploration summaries
  integrity.ts              # DAG integrity checks and repair utilities
  transcript-repair.ts      # Tool-use/result pairing sanitization
  types.ts                  # Core type definitions (dependency injection contracts)
  openclaw-bridge.ts        # Bridge utilities
  db/
    config.ts               # LcmConfig resolution from env vars
    connection.ts           # SQLite connection management
    migration.ts            # Schema migrations
  store/
    conversation-store.ts   # Message persistence and retrieval
    summary-store.ts        # Summary DAG persistence and context item management
    fts5-sanitize.ts        # FTS5 query sanitization
  tools/
    lcm-grep-tool.ts        # lcm_grep tool implementation
    lcm-describe-tool.ts    # lcm_describe tool implementation
    lcm-expand-tool.ts      # lcm_expand tool (sub-agent only)
    lcm-expand-query-tool.ts # lcm_expand_query tool (main agent wrapper)
    lcm-conversation-scope.ts # Conversation scoping utilities
    common.ts               # Shared tool utilities
test/                       # Vitest test suite
specs/                      # Design specifications
openclaw.plugin.json        # Plugin manifest with config schema and UI hints
tui/                        # Interactive terminal UI (Go)
  main.go                   # Entry point and bubbletea app
  data.go                   # Data loading and SQLite queries
  dissolve.go               # Summary dissolution
  repair.go                 # Corrupted summary repair
  rewrite.go                # Summary re-summarization
  transplant.go             # Cross-conversation DAG copy
  prompts/                  # Depth-aware prompt templates
.goreleaser.yml             # GoReleaser config for TUI binary releases
```

## License

MIT
