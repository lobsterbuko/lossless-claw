/**
 * Session State Document — Ozempic Tier 3
 *
 * Maintains a small structured working memory document updated after
 * mutation-provenance turns and injected into the assembled context.
 * Provides the model with a concise, always-current snapshot of domain
 * state without relying on summaries to reconstruct what's true now.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CompleteFn } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionStateFieldDef {
  name: string;
  label: string;
  /** Optional hint shown to the update model about what belongs in this field. */
  description?: string;
}

export interface SessionStateActivityLogConfig {
  enabled: boolean;
  maxEntries: number;
  recallHint: boolean;
}

export interface SessionStateConfig {
  enabled: boolean;
  /** Hard cap on rendered state doc tokens; subtracted from assembly budget. */
  maxTokens: number;
  /** "structured" = named fields only; "hybrid" = named fields + _notes. */
  format: "structured" | "hybrid";
  /** When to trigger an update: "mutation" = after mutation-provenance tools only. */
  updateOn: "mutation" | "any-tool";
  schema: {
    fields: SessionStateFieldDef[];
  };
  activityLog: SessionStateActivityLogConfig;
  /**
   * Optional dedicated model for session state updates.
   * When set, overrides the global summaryModel so session state calls
   * don't compete with compaction summarization on the same model.
   * Format: "<providerId>/<modelId>" or just "<modelId>" if provider is inferred.
   */
  model?: string;
  /** Provider ID for the dedicated session state model. */
  provider?: string;
  /** Whether to enable extended thinking for the session state model. Defaults to false. */
  thinkingEnabled?: boolean;
  /**
   * Fallback model/provider used when the primary model is busy (e.g. compaction in flight).
   * If not set, the update is skipped when the primary is busy.
   */
  fallbackModel?: string;
  fallbackProvider?: string;
  /**
   * Enable compaction-aware routing: route session state to fallbackModel when
   * compaction is in flight, primary model otherwise.
   * Defaults to true when fallbackModel is configured, ignored otherwise.
   * Set to false to disable routing and always use the primary (updates may queue behind compaction).
   */
  routingEnabled?: boolean;
}

export interface ActivityLogEntry {
  /** ISO timestamp of the turn that produced this entry. */
  ts: string;
  /** One-line description of what changed. */
  entry: string;
}

export interface SessionStateRecord {
  sessionId: string;
  agentId: string;
  /** Field values keyed by field name. "_notes" is the freeform hybrid field. */
  fields: Record<string, string>;
  activityLog: ActivityLogEntry[];
  updatedAt: string;
}

// ── Config resolution ─────────────────────────────────────────────────────────

/**
 * Parse a raw context-policy sessionState config object.
 * Returns null if not enabled or invalid.
 * Always fail-open — a bad config disables session state, never breaks assembly.
 */
export function resolveSessionStateConfig(raw: unknown): SessionStateConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return null;

  const config: SessionStateConfig = {
    enabled: true,
    maxTokens: typeof r.maxTokens === "number" && r.maxTokens > 0 ? Math.floor(r.maxTokens) : 300,
    format: r.format === "structured" ? "structured" : "hybrid",
    updateOn: r.updateOn === "any-tool" ? "any-tool" : "mutation",
    schema: { fields: [] },
    activityLog: { enabled: true, maxEntries: 10, recallHint: true },
  };

  // Parse schema fields
  const schemaRaw = r.schema as { fields?: unknown } | undefined;
  if (schemaRaw && Array.isArray(schemaRaw.fields)) {
    config.schema.fields = schemaRaw.fields.filter(
      (f): f is SessionStateFieldDef =>
        f !== null &&
        typeof f === "object" &&
        typeof (f as SessionStateFieldDef).name === "string" &&
        (f as SessionStateFieldDef).name.length > 0 &&
        typeof (f as SessionStateFieldDef).label === "string",
    );
  }

  // Parse activity log config
  const alRaw = r.activityLog as Record<string, unknown> | undefined;
  if (alRaw && typeof alRaw === "object") {
    config.activityLog.enabled = alRaw.enabled !== false;
    if (typeof alRaw.maxEntries === "number" && alRaw.maxEntries > 0) {
      config.activityLog.maxEntries = Math.floor(alRaw.maxEntries);
    }
    config.activityLog.recallHint = alRaw.recallHint !== false;
  }

  // Optional dedicated model for session state updates
  if (typeof r.model === "string" && r.model.trim()) {
    config.model = r.model.trim();
  }
  if (typeof r.provider === "string" && r.provider.trim()) {
    config.provider = r.provider.trim();
  }
  if (typeof r.thinkingEnabled === "boolean") {
    config.thinkingEnabled = r.thinkingEnabled;
  }
  if (typeof r.fallbackModel === "string" && r.fallbackModel.trim()) {
    config.fallbackModel = r.fallbackModel.trim();
  }
  if (typeof r.fallbackProvider === "string" && r.fallbackProvider.trim()) {
    config.fallbackProvider = r.fallbackProvider.trim();
  }
  if (typeof r.routingEnabled === "boolean") {
    config.routingEnabled = r.routingEnabled;
  }

  return config;
}

// ── DB operations ─────────────────────────────────────────────────────────────

export function loadSessionState(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
): SessionStateRecord | null {
  try {
    const row = db
      .prepare(
        `SELECT state_json, updated_at FROM session_state WHERE session_id = ? AND agent_id = ?`,
      )
      .get(sessionId, agentId) as { state_json: string; updated_at: string } | undefined;

    if (!row) return null;

    const parsed = JSON.parse(row.state_json) as {
      fields?: Record<string, string>;
      activityLog?: ActivityLogEntry[];
    };
    return {
      sessionId,
      agentId,
      fields: parsed.fields ?? {},
      activityLog: Array.isArray(parsed.activityLog) ? parsed.activityLog : [],
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export function saveSessionState(db: DatabaseSync, record: SessionStateRecord): void {
  const stateJson = JSON.stringify({
    fields: record.fields,
    activityLog: record.activityLog,
  });
  db.prepare(
    `INSERT INTO session_state (session_id, agent_id, state_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, agent_id)
     DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
  ).run(record.sessionId, record.agentId, stateJson, record.updatedAt);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Format an ISO timestamp for display using the configured timezone. */
function formatActivityTimestamp(isoTs: string, timezone: string): string {
  try {
    return new Date(isoTs).toLocaleTimeString("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoTs;
  }
}

/**
 * Render the [Session State] block for injection into assembled context.
 * Returns the full block string (to be inserted as the first user message).
 */
export function renderSessionStateBlock(
  record: SessionStateRecord,
  config: SessionStateConfig,
  timezone: string,
): string {
  const updatedAtFormatted = formatActivityTimestamp(record.updatedAt, timezone);
  const lines: string[] = [
    `[Session State — updated ${updatedAtFormatted} · raw messages below take precedence if newer]`,
  ];

  // Schema-defined fields
  for (const fieldDef of config.schema.fields) {
    const value = record.fields[fieldDef.name];
    if (value !== undefined && value !== "") {
      lines.push(`${fieldDef.label}: ${value}`);
    }
  }

  // Hybrid freeform notes
  if (config.format === "hybrid" && record.fields._notes) {
    lines.push(`Notes: ${record.fields._notes}`);
  }

  // Activity log
  if (config.activityLog.enabled && record.activityLog.length > 0) {
    lines.push("");
    const header = config.activityLog.recallHint
      ? `[Recent Activity]  — lcm_grep("<timestamp or keyword>") for full context`
      : `[Recent Activity]`;
    lines.push(header);
    for (const entry of record.activityLog) {
      const ts = formatActivityTimestamp(entry.ts, timezone);
      lines.push(`${ts} — ${entry.entry}`);
    }
  }

  return lines.join("\n");
}

/** Rough token estimate for the rendered block (~4 chars per token). */
export function estimateSessionStateTokens(block: string): number {
  return Math.ceil(block.length / 4);
}

// ── Tool result extraction ────────────────────────────────────────────────────

export interface TurnToolResult {
  toolName: string;
  output: string;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
        }
        return "";
      })
      .join("");
  }
  return String(content ?? "");
}

/**
 * Extract tool results from a batch of turn messages.
 * Handles both Anthropic-style (content arrays with tool_use/tool_result blocks)
 * and OpenAI-style (role="tool" messages).
 */
export function extractToolResultsFromMessages(
  messages: Array<{ role: string; content: unknown }>,
): TurnToolResult[] {
  const results: TurnToolResult[] = [];

  // Build a map from tool_use_id → tool_name from assistant messages
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (
        (b.type === "tool_use" || b.type === "tool_call") &&
        typeof b.id === "string" &&
        typeof b.name === "string"
      ) {
        toolNameById.set(b.id, b.name);
      }
    }
  }

  for (const msg of messages) {
    // Anthropic-style tool_result content blocks in user messages
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
        const toolName = toolNameById.get(id) ?? "unknown_tool";
        results.push({ toolName, output: extractTextFromContent(b.content).slice(0, 2000) });
      }
    }

    // OpenAI-style role="tool" messages
    if (msg.role === "tool") {
      const m = msg as Record<string, unknown>;
      const toolName = typeof m.name === "string" ? m.name : "unknown_tool";
      results.push({ toolName, output: extractTextFromContent(msg.content).slice(0, 2000) });
    }

    // OpenClaw-style role="toolResult" messages (toolName is a top-level field)
    if (msg.role === "toolResult") {
      const m = msg as Record<string, unknown>;
      const toolName = typeof m.toolName === "string" ? m.toolName : "unknown_tool";
      results.push({ toolName, output: extractTextFromContent(msg.content).slice(0, 2000) });
    }
  }

  return results;
}

// ── Update via summary model ──────────────────────────────────────────────────

const SESSION_STATE_SYSTEM_PROMPT =
  "You are a session state updater for an AI agent. Extract structured state from tool results and return it as JSON.\n\n" +
  "Critical rules:\n" +
  "- Return ONLY a valid JSON object. No markdown, no explanation, no preamble.\n" +
  "- Only update a field when tool results clearly show that field's value changed.\n" +
  "- Field values must be brief strings (under 100 characters). Never copy raw data or numbers verbatim unless they are the direct answer.\n" +
  "- Read each field's description carefully — only update a field with content that matches its stated purpose.\n" +
  "- 'logEntry' describes what action the agent took, not what the data contains.\n" +
  "- If nothing meaningful changed for a field, omit it from 'fields'.";

function buildUpdatePrompt(
  config: SessionStateConfig,
  current: SessionStateRecord,
  toolResults: TurnToolResult[],
): string {
  const schemaDesc =
    config.schema.fields
      .map((f) => {
        const hint = f.description ? ` — ${f.description}` : "";
        return `  "${f.name}": "${f.label}"${hint}`;
      })
      .join("\n") +
    (config.format === "hybrid" ? `\n  "_notes": "Freeform observations about the session"` : "");

  const currentFields: Record<string, string> = {};
  for (const f of config.schema.fields) {
    if (current.fields[f.name] !== undefined) {
      currentFields[f.name] = current.fields[f.name];
    }
  }
  if (config.format === "hybrid" && current.fields._notes) {
    currentFields._notes = current.fields._notes;
  }

  const allowedKeys =
    config.format === "structured"
      ? config.schema.fields.map((f) => `"${f.name}"`).join(", ")
      : [...config.schema.fields.map((f) => `"${f.name}"`), `"_notes"`].join(", ");

  const toolResultText = toolResults
    .map((r) => `[${r.toolName}]\n${r.output}`)
    .join("\n\n");

  return `Update the session state fields based on the tool results below.

Schema fields:
${schemaDesc}

Current state:
${JSON.stringify(currentFields, null, 2)}

Tool results from this turn:
${toolResultText}

Return a JSON object with exactly this structure:
{
  "fields": { <only changed fields as string key-value pairs> },
  "logEntry": "<one concise sentence describing what changed, no timestamp>"
}

Rules:
- Only include fields that changed in "fields". Omit unchanged fields.
- Only use allowed field keys: ${allowedKeys}
- "logEntry" must be one sentence, under 120 characters.
- Return only the JSON object, nothing else.`;
}

/**
 * Call the summary model to update session state after a mutation turn.
 * Fail-open: on any error, the current state is unchanged.
 */
export async function updateSessionState(params: {
  db: DatabaseSync;
  sessionId: string;
  agentId: string;
  config: SessionStateConfig;
  toolResults: TurnToolResult[];
  timezone: string;
  complete: CompleteFn;
  provider: string;
  model: string;
  apiKey?: string;
  providerApi?: string;
  thinkingEnabled?: boolean;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  if (params.toolResults.length === 0) return;

  const current = loadSessionState(params.db, params.sessionId, params.agentId) ?? {
    sessionId: params.sessionId,
    agentId: params.agentId,
    fields: {},
    activityLog: [],
    updatedAt: new Date().toISOString(),
  };

  const prompt = buildUpdatePrompt(params.config, current, params.toolResults);

  const thinkingEnabled = params.thinkingEnabled ?? false;
  const extraBody: Record<string, unknown> | undefined = !thinkingEnabled
    ? { chat_template_kwargs: { enable_thinking: false } }
    : undefined;

  const TIMEOUT_MS = 30_000;

  let responseText: string;
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`session-state update timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    );
    const result = await Promise.race([
      params.complete({
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        providerApi: params.providerApi,
        messages: [{ role: "user", content: prompt }],
        system: SESSION_STATE_SYSTEM_PROMPT,
        maxTokens: 512,
        // When thinking is enabled, a small temperature lets the reasoning phase explore;
        // the output is still constrained by the strict JSON prompt.
        temperature: thinkingEnabled ? 0.5 : 0,
        extraBody,
      }),
      timeoutPromise,
    ]);
    const textBlock = result.content.find((b) => b.type === "text");
    responseText = textBlock?.text ?? "";
  } catch (err) {
    params.log.warn(
      `[lcm] session-state: model call failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!responseText.trim()) {
    params.log.warn("[lcm] session-state: update returned empty response");
    return;
  }

  // Strip markdown code fences and any thinking-mode preamble before the JSON
  const jsonStart = responseText.indexOf("{");
  const jsonEnd = responseText.lastIndexOf("}");
  const extracted =
    jsonStart !== -1 && jsonEnd > jsonStart
      ? responseText.slice(jsonStart, jsonEnd + 1)
      : responseText;
  const cleaned = extracted
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  let parsed: { fields?: Record<string, unknown>; logEntry?: unknown };
  try {
    parsed = JSON.parse(cleaned) as typeof parsed;
  } catch {
    params.log.warn("[lcm] session-state: could not parse update response as JSON");
    return;
  }

  // Merge fields (only allowed keys)
  const allowedNames = new Set(params.config.schema.fields.map((f) => f.name));
  if (params.config.format === "hybrid") allowedNames.add("_notes");

  const newFields = { ...current.fields };
  if (parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields)) {
    for (const [k, v] of Object.entries(parsed.fields)) {
      if (allowedNames.has(k) && typeof v === "string") {
        newFields[k] = v;
      }
    }
  }

  // Build activity log entry
  const newLog = [...current.activityLog];
  if (params.config.activityLog.enabled) {
    const logEntry =
      typeof parsed.logEntry === "string" ? parsed.logEntry.trim().slice(0, 200) : "";
    if (logEntry) {
      newLog.unshift({ ts: new Date().toISOString(), entry: logEntry });
      while (newLog.length > params.config.activityLog.maxEntries) {
        newLog.pop();
      }
    }
  }

  const updated: SessionStateRecord = {
    sessionId: params.sessionId,
    agentId: params.agentId,
    fields: newFields,
    activityLog: newLog,
    updatedAt: new Date().toISOString(),
  };

  try {
    saveSessionState(params.db, updated);
  } catch (err) {
    params.log.warn(
      `[lcm] session-state: DB write failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
