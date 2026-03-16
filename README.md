# CCOS - Claw Context Operating System

The mission is simple: make small, locally run agents feel dramatically less confused, less forgetful, less fragile under tool pressure, and much more capable over long sessions. We want a local agent to stay sharp, call tools better, execute more reliably, and keep moving without the operator reaching for `/new`. For cloud users, that also means a lot less waste: fewer useless tokens, less repeated context stuffing, and cleaner retrieval. For knowledge, the dream is very much like the Matrix: "I know kung fu" - a way to zap-import expert knowledge as a queryable substrate the agent can reach for on demand. The long-term goal is to make a modest local model feel as close as possible to a big premium model like Claude Opus or GPT-class frontier inference, while staying local-first and operationally sane.

Architecture is explained visually in two CCOS block diagrams: [Turn_Flow_Diagram.png](/Users/jbukow/.openclaw/claw-context-operating-system/Turn_Flow_Diagram.png) and [Context_Assembly_Details.png](/Users/jbukow/.openclaw/claw-context-operating-system/Context_Assembly_Details.png).

-----------------------------------------------------------------------------
MOST IMPORTANT THINGS CCOS CHANGES
-----------------------------------------------------------------------------

-Configure all aspects of your Agents context - what stays, what goes, how it's saved, when it's changed. Actively managed context on every turn. Vastly improves executive function and latency on local agents, and dramatically improves token churn.
- Per-agent context policy. Each agent gets its own `context-policy.json`, so your butler, stock trader, coder, spreadsheet manager, or research assistant can each think differently without forking the whole system.
- Session-state memory. CCOS maintains a compact "what is true right now?" working document per session, so an agent can keep its bearings even when the full transcript would be too large or too messy.
- Tool-result slimming. CCOS truncates or compacts noisy tool output before it poisons the prompt, which gives small models huge context-pressure relief and makes them much better at tool use and follow-up reasoning.
- Imported knowledge packs. Operators can ingest manuals, textbooks, reports, SOPs, or internal docs into a separate retrieval substrate, mount them to agents, and let the agent search them on demand instead of pretending it read 600 pages conversationally.
- Runtime capability injection. Agents can be explicitly reminded, at runtime, that they have memory and knowledge tools available, what packs are mounted, and how to search them.
- Encourage multiple local models: Busy-aware model routing. Session-state and compaction work can be split across different local model lanes, with configurable `fallbackOnBusy`, `fallbackOnFailure`, and per-agent timeouts.

-----------------------------------------------------------------------------
SHORT ARCHITECTURE FLOW
-----------------------------------------------------------------------------

OpenClaw runs the agent turn. `lossless-claw` provides the base DAG memory engine. CCOS sits on top of that engine and decides what to keep hot, what to compress, what to evict, what to store as session truth, what to keep in external knowledge packs, and what to retrieve back into context only when needed. The whole system is trying to do one thing well: store broadly, retrieve narrowly, and keep the active prompt lean enough for a small model to think clearly.


-----------------------------------------------------------------------------
DETAILED ARCHITECTURE
-----------------------------------------------------------------------------

CCOS extends base `lossless-claw` instead of replacing it. The upstream DAG summarization layer still does the foundational work: message persistence, summary graph construction, and recall over compacted history. What CCOS adds is the operational layer that makes long-lived agents actually usable under local-model constraints. Before assembly, CCOS can run a pressure loop to compact history early instead of discovering budget overflow too late. During assembly, it can trim the fresh tail, classify tool results by provenance, evict stale observed facts after mutations, prune low-value acknowledgments, and cap giant tool outputs. After tool-heavy turns, it can generate or refresh a session-state document that acts like a compact working memory ledger: current task, active project, last error, pending follow-up, active files, and next step. That session-state block can then be injected back into later turns as a small structured stabilizer.

Knowledge is handled separately from lived experience. This is a core design decision. Conversation history, tool results, summaries, and session state are one kind of memory: experiential memory. Imported manuals, SOPs, reports, textbooks, and reference docs are another: installed knowledge. CCOS stores those in separate SQLite tables, chunks them, optionally embeds them, mounts them per agent, and retrieves them on demand through `lcm_knowledge_search` and `lcm_knowledge_list`. Mounted packs do not get dumped into the prompt wholesale. The agent sees only the titles and blurbs of what is available, then asks for the specific pieces it needs. That keeps the context window skinny and the agent mentally healthy.

-----------------------------------------------------------------------------
WHAT CCOS FUNCTIONALLY DOES
-----------------------------------------------------------------------------

1. Context-pressure relief

CCOS reduces active prompt bloat before the model gets buried alive. It does this with pre-assembly compaction, fresh-tail trimming, summary-mode control, acknowledgment pruning, and tool-result capping. This is the part that makes a small model feel dramatically less lost in long sessions.

2. Tool-output hygiene

Tool outputs are where local agents often die. A giant shell log, a huge file read, an oversized search dump, or a bloated web result can eat the whole prompt and wreck the next turn. CCOS solves that with:

- deterministic `toolResultCap` truncation
- optional rule-based extraction in `toolResultCompaction`
- provenance-aware interpretation of observed vs computed vs mutated state

This gives better downstream reasoning, better tool choice, and fewer nonsense follow-ups.

3. Session-state working memory

CCOS can generate a structured session-state document after tool-heavy turns. This is not a transcript and not a summary of "everything that happened." It is the compact operational answer to "what is true right now?" That distinction matters. A small local model can use a 300-450 token state block much more effectively than a slurry of old conversation.

4. Agent-specific summarization

The summarizer can now be steered per agent with `summaryInstructions`. That means Timetrack can preserve spreadsheet anomalies and exact ranges, Buko can preserve delegated follow-ups and reminders, Martha can preserve calendar and finance commitments, and Coder can preserve file changes, commands, stack traces, and design decisions. If no custom instructions exist, CCOS falls back to its default behavior.

5. Busy-aware multi-model routing

CCOS assumes a split-lane local stack is normal. You may have one strong reasoning lane, one summary lane, one fallback lane, plus embedding and reranker services. Session-state work can stay on a primary model or fall back when the summary lane is busy. `fallbackOnBusy` is meant for live contention. `fallbackOnFailure` is a different switch and should be used more sparingly. This matters a lot on local boxes where one model can be perfectly healthy but simply occupied.

6. Knowledge packs

This is the imported-memory layer from the v3 work. The operator imports a file offline, CCOS extracts text, chunks it, optionally embeds it, stores it in `lcm.db`, and mounts it to one or more agents. The agent can then discover and search it. This is the "Neo learning kung fu" part of the system. The agent does not fake-read the corpus in chat. Instead, the system installs a structured retrieval substrate that the agent can consult instantly when the task calls for it.

Supported import formats in the current implementation:

- `txt`
- `md`
- `json`
- `html`
- `htm`
- `docx`
- `doc`
- `rtf`
- `rtfd`
- `pdf`

Current operator workflow:

```bash
npm run knowledge:admin -- import --agent coder --pack-id my-pack --file /absolute/path/to/file.md
npm run knowledge:admin -- mount --agent coder --pack-id my-pack
npm run knowledge:admin -- list --agent coder
npm run knowledge:admin -- audit --pack-id my-pack
npm run knowledge:admin -- repair --agent coder --pack-id my-pack
npm run knowledge:admin -- unmount --agent coder --pack-id my-pack
```

The new `audit` and `repair` commands exist because real systems get messy. Imports can be interrupted. SQLite can get locked. A pack can be imported twice. CCOS now has operator tools to detect duplicate docs, partial embeddings, and repair them instead of shrugging and hoping retrieval still works.

7. Runtime memory / knowledge reminders

CCOS can inject runtime hints into the system prompt so the agent knows, explicitly, that it has memory and knowledge available. For knowledge, it can inject a short mounted-pack list and an example search query. For memory, it can inject a compact reminder that LCM recall tools exist and when to use them. This keeps capability knowledge dynamic instead of burying it only in workspace prose.

8. Observability and forensics

CCOS writes append-only JSONL logs for:

- summarization calls
- session-state calls
- embedding calls
- reranker calls

Those live in `~/.openclaw/usage-logs/lcm-llm-usage.jsonl`. We also added session reconstruction so raw OpenClaw session JSONLs can be turned into readable per-session markdown logs. Between the session transcript and the LLM usage log, you can answer the important operational questions:

- What did the agent actually do?
- What model did CCOS call?
- What raw request was sent?
- Did the call complete, fail, or time out?
- Did the agent use memory, knowledge, web search, or just freestyle?

-----------------------------------------------------------------------------
WHAT IS CONFIGURABLE
-----------------------------------------------------------------------------

CCOS is meant to be tuned at two levels: global runtime defaults in plugin config, and per-agent behavior in workspace policy.

At the strategic level, the big levers are easy to understand:

- `summaryInstructions` decides what an agent should preserve as durable memory.
- `memory.*` controls whether the agent is reminded to use LCM recall and session continuity.
- `knowledge.*` controls whether the agent is told about mounted packs and how to search them.
- `sessionState.*` controls whether the agent gets a compact "what is true right now?" operational ledger.
- `toolResultCompaction` and `overrides.toolResultCap` decide how hard CCOS fights tool-output bloat.
- `toolClassification.*` tells CCOS which tools report observations, which compute, and which mutate reality.
- `freshnessTtl.*` decides when observed data should be treated as stale.
- `search.embedding.*` and `search.reranker.*` control the retrieval stack behind imported knowledge.

Global plugin configuration lives under OpenClaw plugin config and controls the engine-wide behavior. Important knobs include:

- `pressureLoop` and `pressureMaxPasses`
- `freshTailTrimUnderPressure`
- `provenanceTyping`
- `provenanceEviction`
- `summaryMode`
- `toolResultCap`
- `ackPruning`
- `ackPruningMaxTokens`
- summary-model routing and thinking controls inherited from the plugin/runtime layer

Per-agent configuration lives in `workspace-<agent>/context-policy.json`. Current policy surfaces include:

- `summaryInstructions`
- `memory.enabled`
- `memory.injectHint`
- `knowledge.enabled`
- `knowledge.injectPackList`
- `knowledge.maxInjectedPacks`
- `knowledge.exampleQuery`
- `overrides.summaryMode`
- `overrides.toolResultCap`
- `overrides.ackPruning`
- `overrides.ackPruningMaxTokens`
- `toolResultCompaction.rules`
- `toolClassification.observed`
- `toolClassification.computed`
- `toolClassification.mutation`
- `freshnessTtl.default`
- `freshnessTtl.byTool`
- `sessionState.enabled`
- `sessionState.maxTokens`
- `sessionState.format`
- `sessionState.updateOn`
- `sessionState.schema.fields`
- `sessionState.activityLog.enabled`
- `sessionState.activityLog.maxEntries`
- `sessionState.activityLog.recallHint`
- `sessionState.provider`
- `sessionState.model`
- `sessionState.thinkingEnabled`
- `sessionState.timeoutMs`
- `sessionState.fallbackOnBusy`
- `sessionState.fallbackOnFailure`
- `sessionState.fallbackProvider`
- `sessionState.fallbackModel`
- `sessionState.routingEnabled`
- `search.embedding.baseUrl`
- `search.embedding.apiKey`
- `search.embedding.model`
- `search.embedding.dimensions`
- `search.embedding.taskInstruction`
- `search.reranker.baseUrl`
- `search.reranker.apiKey`
- `search.reranker.model`
- `search.reranker.taskInstruction`
- `search.reranker.maxCandidates`
- `search.reranker.topK`

-----------------------------------------------------------------------------
STARTER CONFIGS
-----------------------------------------------------------------------------


The fastest way to understand CCOS is to picture what it does for different kinds of agents. Same engine. Different policies. Different behavior. Different results.

1. Butler

```json
{
  "summaryInstructions": "Preserve commitments, reminders, delegated follow-ups, household preferences, and unfinished errands.",
  "memory": { "enabled": true, "injectHint": true },
  "knowledge": { "enabled": false },
  "sessionState": {
    "enabled": true,
    "updateOn": "perTurn",
    "timeoutMs": 180000,
    "fallbackOnBusy": true,
    "fallbackOnFailure": false
  },
  "freshnessTtl": {
    "byTool": {
      "calendar": 300000,
      "tasks": 300000
    }
  }
}
```

Why this works: a butler agent lives and dies by continuity. The win is not brilliance. The win is not dropping commitments, not forgetting the shopping list, and not losing the thread after ten turns and five tool calls. Strong session-state plus reminder-preserving summaries makes the agent feel attentive and reliable.

2. Stock Trader

```json
{
  "summaryInstructions": "Preserve positions, watchlists, open hypotheses, macro regime assumptions, recent catalysts, and unresolved research questions.",
  "memory": { "enabled": true, "injectHint": true },
  "knowledge": { "enabled": true, "injectPackList": true, "exampleQuery": "Search the market-playbook pack for earnings-gap risk management." },
  "overrides": {
    "toolResultCap": 1200,
    "summaryMode": "aggressive"
  },
  "toolClassification": {
    "observed": ["market_data", "news_feed"],
    "computed": ["analysis"],
    "mutation": ["portfolio_update"]
  },
  "sessionState": {
    "enabled": true,
    "updateOn": "toolHeavy",
    "fallbackOnBusy": true
  }
}
```

Why this works: trader-style agents drown in noisy feeds fast. CCOS keeps fresh market observations short-lived, compresses tool output hard, and preserves the durable things that matter: positions, theses, and pending decisions. Mounted playbooks or research packs turn the agent from "vaguely finance-shaped" into "trained on your actual trading framework."

3. Coder

```json
{
  "summaryInstructions": "Preserve file changes, design decisions, stack traces, commands run, pending refactors, and unresolved bugs.",
  "memory": { "enabled": true, "injectHint": true },
  "knowledge": { "enabled": true, "injectPackList": true, "exampleQuery": "Search the system-manual pack for gateway restart behavior." },
  "toolResultCompaction": {
    "rules": [
      { "tool": "exec", "strategy": "tail" },
      { "tool": "read_file", "strategy": "head_tail" }
    ]
  },
  "sessionState": {
    "enabled": true,
    "updateOn": "perTurn",
    "schema": { "fields": ["task", "files", "errors", "nextStep"] },
    "fallbackOnBusy": true
  }
}
```

Why this works: coding agents get wrecked by giant logs, giant diffs, and long multi-file arcs. CCOS keeps the current task ledger tight, remembers what broke, and keeps implementation context warm without stuffing half the repo into the prompt every turn.

4. Excel Sheet Manager

```json
{
  "summaryInstructions": "Preserve workbook names, sheet names, ranges, formulas discussed, anomalies, and pending spreadsheet actions.",
  "memory": { "enabled": true, "injectHint": true },
  "knowledge": { "enabled": false },
  "overrides": {
    "toolResultCap": 900
  },
  "sessionState": {
    "enabled": true,
    "updateOn": "toolHeavy",
    "schema": { "fields": ["activeWorkbook", "activeSheet", "ranges", "pendingAction"] }
  }
}
```

Why this works: spreadsheet agents need exact operational memory, not broad literary memory. Preserving workbook, sheet, range, and formula references makes the agent far less likely to mutate the wrong place or lose track of what the operator meant by "that tab."

5. Chess Analyst

```json
{
  "summaryInstructions": "Preserve openings discussed, candidate moves, evaluation disagreements, tactical motifs, and training goals.",
  "memory": { "enabled": true, "injectHint": true },
  "knowledge": { "enabled": true, "injectPackList": true, "exampleQuery": "Search the chess pack for plans against the Caro-Kann Advance." },
  "sessionState": {
    "enabled": true,
    "updateOn": "perTurn",
    "fallbackOnBusy": false
  }
}
```

Why this works: a chess agent becomes much more useful when it can combine session continuity with imported opening manuals or training notes. This is exactly the "I know kung fu" use case: install structured expertise, then retrieve only the relevant lines and plans when the position calls for it.

6. Poet

```json
{
  "summaryInstructions": "Preserve voice, themes, image systems, constraints, references, and the emotional target of the piece.",
  "memory": { "enabled": true, "injectHint": true },
  "knowledge": { "enabled": true, "injectPackList": true, "exampleQuery": "Search the style-pack for examples of restrained surreal imagery." },
  "overrides": {
    "ackPruning": true,
    "ackPruningMaxTokens": 120
  },
  "sessionState": {
    "enabled": true,
    "updateOn": "toolHeavy"
  }
}
```

Why this works: creative agents suffer when the prompt fills up with chatter and loses the artistic brief. CCOS helps preserve the style bible, current imagery, and formal constraints, while cutting low-value conversational fluff.

7. Online Shopper

```json
{
  "summaryInstructions": "Preserve constraints, budget, preferred brands, rejected options, shipping requirements, and purchase rationale.",
  "memory": { "enabled": true, "injectHint": true },
  "knowledge": { "enabled": true, "injectPackList": true, "exampleQuery": "Search the buying-guide pack for carry-on luggage durability criteria." },
  "freshnessTtl": {
    "byTool": {
      "shopping_search": 900000,
      "price_lookup": 300000
    }
  },
  "sessionState": {
    "enabled": true,
    "updateOn": "toolHeavy",
    "fallbackOnBusy": true
  }
}
```

Why this works: shopping agents often repeat themselves, forget constraints, and get distracted by the latest search result. CCOS keeps the constraint set stable and the evidence fresh, so the agent behaves more like a careful buyer and less like a goldfish with a browser tab.


-----------------------------------------------------------------------------
CURRENT REAL-WORLD SHAPE OF THE STACK
-----------------------------------------------------------------------------

In the current installation this fork has been living in, the system has been run as a split local stack:

- a large reasoning lane for main agent turns
- a 9B summary/session-state lane
- a 4B fallback lane for selective session-state routing
- local embedding and reranker services for memory and knowledge retrieval

The important design point is not the exact model names. The important design point is that CCOS expects this kind of local heterogeneity and gives you knobs to route around it instead of pretending one single model should do every job.


-----------------------------------------------------------------------------
WHY THIS EXISTS AT ALL
-----------------------------------------------------------------------------

The whole point of CCOS is to make a small local agent stop acting small. Less confusion. Less context poisoning. Better tool calls. Better continuity. Better recovery after long sessions. Better use of narrow prompts. Better handling of giant tool output. Much better access to installed expert knowledge. Lower token waste. Fewer operator resets. No more living in fear of `/new`.

That is the dream.

Not a demo.
Not a toy.
Not "memory" in the vague marketing sense.

A real context operating system for agents.
