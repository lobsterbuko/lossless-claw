import type { ContextEngine } from "openclaw/plugin-sdk";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import { classifyToolProvenance, type ManifestItem, type ProvenanceKind } from "./context-manifest.js";
import {
  applyCompactionRules,
  isFreshnessExpired,
  resolveToolProvenanceWithPolicy,
  type ContextPolicy,
} from "./context-policy.js";
import type {
  ConversationStore,
  MessagePartRecord,
  MessageRole,
} from "./store/conversation-store.js";
import type { SummaryStore, ContextItemRecord, SummaryRecord } from "./store/summary-store.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

// ── Public types ─────────────────────────────────────────────────────────────

export interface AssembleContextInput {
  conversationId: number;
  tokenBudget: number;
  /** Number of most recent raw turns to always include (default: 8) */
  freshTailCount?: number;
  // ── Ozempic Tier 1 feature flags ─────────────────────────────────────────────
  /** Trim oldest fresh-tail items instead of overflowing when fresh tail exceeds budget. */
  freshTailTrimUnderPressure?: boolean;
  /** Classify tool results by provenance kind and attach metadata for manifest building. */
  provenanceTyping?: boolean;
  /** Evict stale observed results when a mutation from the same tool is present. */
  provenanceEviction?: boolean;
  // ── Ozempic Tier 2 heuristic flags ───────────────────────────────────────────
  /** Summary inclusion strategy: "always" | "on-demand" | "auto". */
  summaryMode?: "always" | "on-demand" | "auto";
  /** Max tokens per tool result; 0 = unlimited. */
  toolResultCap?: number;
  /** How to handle previous-turn reasoning traces: "keep" | "drop". */
  reasoningTraceMode?: "keep" | "drop";
  /** Remove low-value acknowledgment exchanges from the evictable pool. */
  ackPruning?: boolean;
  /** Token threshold for acknowledgment candidate detection. */
  ackPruningMaxTokens?: number;
  // ── Ozempic Tier 3 agent-specific policy ─────────────────────────────────────
  /** Per-agent context policy (loaded from workspace context-policy.json). */
  contextPolicy?: ContextPolicy | null;
  /**
   * Pre-rendered session state block to inject as the first message.
   * Token cost has already been subtracted from tokenBudget by the engine.
   */
  sessionStateBlock?: string;
}

export interface AssembleContextResult {
  /** Ordered messages ready for the model */
  messages: AgentMessage[];
  /** Total estimated tokens */
  estimatedTokens: number;
  /** Optional dynamic system prompt guidance derived from DAG state */
  systemPromptAddition?: string;
  /** Stats about what was assembled */
  stats: {
    rawMessageCount: number;
    summaryCount: number;
    totalContextItems: number;
    /** Number of fresh-tail items trimmed under budget pressure (Ozempic). */
    freshTailTrimmed: number;
    /** Number of stale observed items evicted after a mutation (Ozempic). */
    evictedStaleObserved: number;
    /** Number of acknowledgment messages pruned from the evictable pool (Ozempic). */
    ackPruned: number;
  };
  /** Populated when provenanceTyping is enabled. Used by engine to build context manifest. */
  manifestItems?: ManifestItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Simple token estimate: ~4 chars per token, same as VoltCode's Token.estimate */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Returns true if the message contains tool-call or tool-result content. */
function hasToolContent(message: AgentMessage): boolean {
  if (message.role === "toolResult") return true;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: string };
    return (
      b.type === "tool_use" ||
      b.type === "toolUse" ||
      b.type === "tool-use" ||
      b.type === "function_call" ||
      b.type === "functionCall"
    );
  });
}

type SummaryPromptSignal = Pick<SummaryRecord, "kind" | "depth" | "descendantCount">;

/**
 * Build LCM usage guidance for the runtime system prompt.
 *
 * Guidance is emitted only when summaries are present in assembled context.
 * Depth-aware: minimal for shallow compaction, full guidance for deep trees.
 */
function buildSystemPromptAddition(summarySignals: SummaryPromptSignal[]): string | undefined {
  if (summarySignals.length === 0) {
    return undefined;
  }

  const maxDepth = summarySignals.reduce((deepest, signal) => Math.max(deepest, signal.depth), 0);
  const condensedCount = summarySignals.filter((signal) => signal.kind === "condensed").length;
  const heavilyCompacted = maxDepth >= 2 || condensedCount >= 2;

  const sections: string[] = [];

  // Core recall workflow — always present when summaries exist
  sections.push(
    "## LCM Recall",
    "",
    "Summaries above are compressed context — maps to details, not the details themselves.",
    "",
    "**Recall priority:** Use LCM tools for all memory recall. Do not use memory_search or qmd.",
    "",
    "**Tool escalation:**",
    "1. `lcm_grep` — search by regex or full-text across messages and summaries",
    "2. `lcm_describe` — inspect a specific summary (cheap, no sub-agent)",
    "3. `lcm_expand_query` — deep recall: spawns bounded sub-agent, expands DAG, returns answer with cited summary IDs (~120s, don't ration it)",
    "",
    "**`lcm_expand_query` usage** — two patterns (always requires `prompt`):",
    "- With IDs: `lcm_expand_query(summaryIds: [\"sum_xxx\"], prompt: \"What config changes were discussed?\")`",
    "- With search: `lcm_expand_query(query: \"database migration\", prompt: \"What strategy was decided?\")`",
    "- Optional: `maxTokens` (default 2000), `conversationId`, `allConversations: true`",
    "",
    "**Summaries include \"Expand for details about:\" footers** listing compressed specifics. Use `lcm_expand_query` with that summary's ID to retrieve them.",
  );

  // Precision/evidence rules — always present but stronger when heavily compacted
  if (heavilyCompacted) {
    sections.push(
      "",
      "**\u26a0 Deeply compacted context — expand before asserting specifics.**",
      "",
      "Default recall flow for precision work:",
      "1) `lcm_grep` to locate relevant summary/message IDs",
      "2) `lcm_expand_query` with a focused prompt",
      "3) Answer with citations to summary IDs used",
      "",
      "**Uncertainty checklist (run before answering):**",
      "- Am I making exact factual claims from a condensed summary?",
      "- Could compaction have omitted a crucial detail?",
      "- Would this answer fail if the user asks for proof?",
      "",
      "If yes to any \u2192 expand first.",
      "",
      "**Do not guess** exact commands, SHAs, file paths, timestamps, config values, or causal claims from condensed summaries. Expand first or state that you need to expand.",
    );
  } else {
    sections.push(
      "",
      "**For precision/evidence questions** (exact commands, SHAs, paths, timestamps, config values, root-cause chains): expand before answering.",
      "Do not guess from condensed summaries — expand first or state uncertainty.",
    );
  }

  return sections.join("\n");
}

/**
 * Map a DB message role to an AgentMessage role.
 *
 *   user      -> user
 *   assistant -> assistant
 *   system    -> user       (system prompts presented as user messages)
 *   tool      -> assistant  (tool results are part of assistant turns)
 */
function parseJson(value: string | null): unknown {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getOriginalRole(parts: MessagePartRecord[]): string | null {
  for (const part of parts) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const role = (decoded as { originalRole?: unknown }).originalRole;
    if (typeof role === "string" && role.length > 0) {
      return role;
    }
  }
  return null;
}

function getPartMetadata(part: MessagePartRecord): {
  originalRole?: string;
  rawType?: string;
  raw?: unknown;
} {
  const decoded = parseJson(part.metadata);
  if (!decoded || typeof decoded !== "object") {
    return {};
  }

  const record = decoded as {
    originalRole?: unknown;
    rawType?: unknown;
    raw?: unknown;
  };
  return {
    originalRole:
      typeof record.originalRole === "string" && record.originalRole.length > 0
        ? record.originalRole
        : undefined,
    rawType:
      typeof record.rawType === "string" && record.rawType.length > 0
        ? record.rawType
        : undefined,
    raw: record.raw,
  };
}

function parseStoredValue(value: string | null): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = parseJson(value);
  return parsed !== undefined ? parsed : value;
}

function reasoningBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type = rawType === "thinking" ? "thinking" : "reasoning";
  if (typeof part.textContent === "string" && part.textContent.length > 0) {
    return type === "thinking"
      ? { type, thinking: part.textContent }
      : { type, text: part.textContent };
  }
  return { type };
}

/**
 * Detect if a raw block is an OpenClaw-normalised OpenAI reasoning item.
 * OpenClaw converts OpenAI `{type:"reasoning", id:"rs_…", encrypted_content:"…"}`
 * into `{type:"thinking", thinking:"", thinkingSignature:"{…}"}`.
 * When we reassemble for the OpenAI provider we need the original back.
 */
function tryRestoreOpenAIReasoning(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.type !== "thinking") return null;
  const sig = raw.thinkingSignature;
  if (typeof sig !== "string" || !sig.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(sig) as Record<string, unknown>;
    if (parsed.type === "reasoning" && typeof parsed.id === "string") {
      return parsed;
    }
  } catch {
    // not valid JSON — leave as-is
  }
  return null;
}

function toolCallBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type =
    rawType === "function_call" ||
    rawType === "functionCall" ||
    rawType === "tool_use" ||
    rawType === "tool-use" ||
    rawType === "toolUse" ||
    rawType === "toolCall"
      ? rawType
      : "toolCall";
  const input = parseStoredValue(part.toolInput);
  const block: Record<string, unknown> = { type };

  if (type === "function_call") {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      block.call_id = part.toolCallId;
    }
    if (typeof part.toolName === "string" && part.toolName.length > 0) {
      block.name = part.toolName;
    }
    if (input !== undefined) {
      block.arguments = input;
    }
    return block;
  }

  if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
    block.id = part.toolCallId;
  }
  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
  }

  if (input !== undefined) {
    if (type === "functionCall") {
      block.arguments = input;
    } else {
      block.input = input;
    }
  }
  return block;
}

function toolResultBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type =
    rawType === "function_call_output" || rawType === "toolResult" || rawType === "tool_result"
      ? rawType
      : "tool_result";
  const output = parseStoredValue(part.toolOutput) ?? part.textContent ?? "";
  const block: Record<string, unknown> = { type, output };

  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
  }

  if (type === "function_call_output") {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      block.call_id = part.toolCallId;
    }
    return block;
  }

  if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
    block.tool_use_id = part.toolCallId;
  }
  return block;
}

function toRuntimeRole(
  dbRole: MessageRole,
  parts: MessagePartRecord[],
): "user" | "assistant" | "toolResult" {
  const originalRole = getOriginalRole(parts);
  if (originalRole === "toolResult") {
    return "toolResult";
  }
  if (originalRole === "assistant") {
    return "assistant";
  }
  if (originalRole === "user") {
    return "user";
  }
  if (originalRole === "system") {
    // Runtime system prompts are managed via setSystemPrompt(), not message history.
    return "user";
  }

  if (dbRole === "tool") {
    return "toolResult";
  }
  if (dbRole === "assistant") {
    return "assistant";
  }
  return "user"; // user | system
}

function blockFromPart(part: MessagePartRecord): unknown {
  const metadata = getPartMetadata(part);
  if (metadata.raw && typeof metadata.raw === "object") {
    // If this is an OpenClaw-normalised OpenAI reasoning block, restore the original
    // OpenAI format so the Responses API gets the {type:"reasoning", id:"rs_…"} it expects.
    const restored = tryRestoreOpenAIReasoning(metadata.raw as Record<string, unknown>);
    if (restored) return restored;
    return metadata.raw;
  }

  if (part.partType === "reasoning") {
    return reasoningBlockFromPart(part, metadata.rawType);
  }
  if (part.partType === "tool") {
    if (metadata.originalRole === "toolResult" || metadata.rawType === "function_call_output") {
      return toolResultBlockFromPart(part, metadata.rawType);
    }
    return toolCallBlockFromPart(part, metadata.rawType);
  }
  if (
    metadata.rawType === "function_call" ||
    metadata.rawType === "functionCall" ||
    metadata.rawType === "tool_use" ||
    metadata.rawType === "tool-use" ||
    metadata.rawType === "toolUse" ||
    metadata.rawType === "toolCall"
  ) {
    return toolCallBlockFromPart(part, metadata.rawType);
  }
  if (
    metadata.rawType === "function_call_output" ||
    metadata.rawType === "tool_result" ||
    metadata.rawType === "toolResult"
  ) {
    return toolResultBlockFromPart(part, metadata.rawType);
  }
  if (part.partType === "text") {
    return { type: "text", text: part.textContent ?? "" };
  }

  if (typeof part.textContent === "string" && part.textContent.length > 0) {
    return { type: "text", text: part.textContent };
  }

  const decodedFallback = parseJson(part.metadata);
  if (decodedFallback && typeof decodedFallback === "object") {
    return {
      type: "text",
      text: JSON.stringify(decodedFallback),
    };
  }
  return { type: "text", text: "" };
}

function contentFromParts(
  parts: MessagePartRecord[],
  role: "user" | "assistant" | "toolResult",
  fallbackContent: string,
): unknown {
  if (parts.length === 0) {
    if (role === "assistant") {
      return fallbackContent ? [{ type: "text", text: fallbackContent }] : [];
    }
    if (role === "toolResult") {
      return [{ type: "text", text: fallbackContent }];
    }
    return fallbackContent;
  }

  const blocks = parts.map(blockFromPart);
  if (
    role === "user" &&
    blocks.length === 1 &&
    blocks[0] &&
    typeof blocks[0] === "object" &&
    (blocks[0] as { type?: unknown }).type === "text" &&
    typeof (blocks[0] as { text?: unknown }).text === "string"
  ) {
    return (blocks[0] as { text: string }).text;
  }
  return blocks;
}

function pickToolCallId(parts: MessagePartRecord[]): string | undefined {
  for (const part of parts) {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      return part.toolCallId;
    }
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataToolCallId = (decoded as { toolCallId?: unknown }).toolCallId;
    if (typeof metadataToolCallId === "string" && metadataToolCallId.length > 0) {
      return metadataToolCallId;
    }
    const raw = (decoded as { raw?: unknown }).raw;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const maybe = (raw as { toolCallId?: unknown; tool_call_id?: unknown }).toolCallId;
    if (typeof maybe === "string" && maybe.length > 0) {
      return maybe;
    }
    const maybeSnake = (raw as { tool_call_id?: unknown }).tool_call_id;
    if (typeof maybeSnake === "string" && maybeSnake.length > 0) {
      return maybeSnake;
    }
  }
  return undefined;
}

function pickToolName(parts: MessagePartRecord[]): string | undefined {
  for (const part of parts) {
    if (typeof part.toolName === "string" && part.toolName.length > 0) {
      return part.toolName;
    }
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataToolName = (decoded as { toolName?: unknown }).toolName;
    if (typeof metadataToolName === "string" && metadataToolName.length > 0) {
      return metadataToolName;
    }
    const raw = (decoded as { raw?: unknown }).raw;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const maybe = (raw as { name?: unknown }).name;
    if (typeof maybe === "string" && maybe.length > 0) {
      return maybe;
    }
    const maybeCamel = (raw as { toolName?: unknown }).toolName;
    if (typeof maybeCamel === "string" && maybeCamel.length > 0) {
      return maybeCamel;
    }
  }
  return undefined;
}

function pickToolIsError(parts: MessagePartRecord[]): boolean | undefined {
  for (const part of parts) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataIsError = (decoded as { isError?: unknown }).isError;
    if (typeof metadataIsError === "boolean") {
      return metadataIsError;
    }
  }
  return undefined;
}

/** Format a Date for XML attributes in the agent's timezone. */
function formatDateForAttribute(date: Date, timezone?: string): string {
  const tz = timezone ?? "UTC";
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const p = Object.fromEntries(
      fmt.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return date.toISOString();
  }
}

/**
 * Format a summary record into the XML payload string the model sees.
 */
async function formatSummaryContent(
  summary: SummaryRecord,
  summaryStore: SummaryStore,
  timezone?: string,
): Promise<string> {
  const attributes = [
    `id="${summary.summaryId}"`,
    `kind="${summary.kind}"`,
    `depth="${summary.depth}"`,
    `descendant_count="${summary.descendantCount}"`,
  ];
  if (summary.earliestAt) {
    attributes.push(`earliest_at="${formatDateForAttribute(summary.earliestAt, timezone)}"`);
  }
  if (summary.latestAt) {
    attributes.push(`latest_at="${formatDateForAttribute(summary.latestAt, timezone)}"`);
  }

  const lines: string[] = [];
  lines.push(`<summary ${attributes.join(" ")}>`); 

  // For condensed summaries, include parent references.
  if (summary.kind === "condensed") {
    const parents = await summaryStore.getSummaryParents(summary.summaryId);
    if (parents.length > 0) {
      lines.push("  <parents>");
      for (const parent of parents) {
        lines.push(`    <summary_ref id="${parent.summaryId}" />`);
      }
      lines.push("  </parents>");
    }
  }

  lines.push("  <content>");
  lines.push(summary.content);
  lines.push("  </content>");
  lines.push("</summary>");
  return lines.join("\n");
}

// ── Resolved context item (after fetching underlying message/summary) ────────

interface ResolvedItem {
  /** Original ordinal from context_items table */
  ordinal: number;
  /** The AgentMessage ready for the model */
  message: AgentMessage;
  /** Estimated token count for this item */
  tokens: number;
  /** Whether this came from a raw message (vs. a summary) */
  isMessage: boolean;
  /** DB role of the underlying message (Ozempic provenance). */
  dbRole?: string;
  /** Tool name, populated for tool-result messages (Ozempic provenance). */
  toolName?: string;
  /** Classified provenance kind (Ozempic). */
  provenance?: ProvenanceKind;
  /** Message creation timestamp, used for freshness TTL eviction (Ozempic Tier 3). */
  createdAt?: Date;
  /** Summary metadata used for dynamic system prompt guidance */
  summarySignal?: SummaryPromptSignal;
}

// ── ContextAssembler ─────────────────────────────────────────────────────────

export class ContextAssembler {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private timezone?: string,
  ) {}

  /**
   * Build model context under a token budget.
   *
   * 1. Fetch all context items for the conversation (ordered by ordinal).
   * 2. Resolve each item into an AgentMessage (fetching the underlying
   *    message or summary record).
   * 3. Protect the "fresh tail" (last N items) from truncation.
   * 4. If over budget, drop oldest non-fresh items until we fit.
   * 5. Return the final ordered messages in chronological order.
   */
  async assemble(input: AssembleContextInput): Promise<AssembleContextResult> {
    const { conversationId, tokenBudget } = input;
    const freshTailCount = input.freshTailCount ?? 8;
    const freshTailTrimUnderPressure = input.freshTailTrimUnderPressure ?? false;
    const provenanceTyping = input.provenanceTyping ?? false;
    const provenanceEviction = input.provenanceEviction ?? false;
    const summaryMode = input.summaryMode ?? "auto";
    const toolResultCap = input.toolResultCap ?? 0;
    const reasoningTraceMode = input.reasoningTraceMode ?? "keep";
    const ackPruning = input.ackPruning ?? false;
    const ackPruningMaxTokens = input.ackPruningMaxTokens ?? 30;
    const contextPolicy = input.contextPolicy ?? null;

    // Step 1: Get all context items ordered by ordinal
    const contextItems = await this.summaryStore.getContextItems(conversationId);

    if (contextItems.length === 0) {
      return {
        messages: [],
        estimatedTokens: 0,
        stats: { rawMessageCount: 0, summaryCount: 0, totalContextItems: 0, freshTailTrimmed: 0, evictedStaleObserved: 0, ackPruned: 0 },
      };
    }

    // Step 2: Resolve each context item into a ResolvedItem
    let resolved = await this.resolveItems(contextItems);

    // Ozempic: classify provenance on all resolved items
    if (provenanceTyping) {
      for (const item of resolved) {
        if (item.dbRole === "tool" && item.toolName) {
          // Tier 3: use policy-aware classifier (falls back to default heuristics)
          item.provenance = resolveToolProvenanceWithPolicy(item.toolName, contextPolicy);
        } else if (item.dbRole === "user") {
          item.provenance = "user_prompt";
        } else if (item.dbRole === "assistant") {
          item.provenance = "assistant_answer";
        } else if (!item.isMessage) {
          item.provenance = "summary";
        }
      }
    }

    // Ozempic: summary mode filter
    // "on-demand" — never include summaries; agent fetches via LCM tools as needed.
    // "auto"       — skip summaries when all raw messages already fit in budget
    //                (they waste tokens when there's no pressure).
    // "always"     — include summaries (default behaviour, no filter).
    if (summaryMode === "on-demand") {
      resolved = resolved.filter((item) => item.isMessage);
    } else if (summaryMode === "auto") {
      const rawOnlyTokens = resolved.reduce((sum, item) => sum + (item.isMessage ? item.tokens : 0), 0);
      if (rawOnlyTokens <= tokenBudget) {
        // Everything fits without summaries — leave them out to keep context clean.
        resolved = resolved.filter((item) => item.isMessage);
      }
      // If over budget, summaries provide coverage for dropped raw messages — keep them.
    }

    // Count stats from the full (pre-truncation) set
    let rawMessageCount = 0;
    let summaryCount = 0;
    const summarySignals: SummaryPromptSignal[] = [];
    for (const item of resolved) {
      if (item.isMessage) {
        rawMessageCount++;
      } else {
        summaryCount++;
        if (item.summarySignal) {
          summarySignals.push(item.summarySignal);
        }
      }
    }

    const systemPromptAddition = buildSystemPromptAddition(summarySignals);

    // Step 3: Split into evictable prefix and protected fresh tail
    const tailStart = Math.max(0, resolved.length - freshTailCount);
    let freshTail = resolved.slice(tailStart);
    const evictable = resolved.slice(0, tailStart);

    // Step 4: Budget-aware selection
    // First, compute the token cost of the fresh tail (always included).
    let tailTokens = 0;
    for (const item of freshTail) {
      tailTokens += item.tokens;
    }

    // Ozempic: fresh tail trimming under pressure.
    // If fresh tail alone exceeds budget, trim from the oldest end
    // rather than overflowing (preserves the newest items).
    let freshTailTrimmed = 0;
    if (freshTailTrimUnderPressure && tailTokens > tokenBudget && freshTail.length > 1) {
      let trimIdx = 0;
      let runningTokens = tailTokens;
      while (runningTokens > tokenBudget && trimIdx < freshTail.length - 1) {
        runningTokens -= freshTail[trimIdx].tokens;
        trimIdx++;
        freshTailTrimmed++;
      }
      if (trimIdx > 0) {
        freshTail = freshTail.slice(trimIdx);
        tailTokens = runningTokens;
      }
    }

    // Fill remaining budget from evictable items, oldest first.
    // If the fresh tail alone exceeds the budget we still include it
    // (we never drop fresh items), but we skip all evictable items.
    const remainingBudget = Math.max(0, tokenBudget - tailTokens);
    let selected: ResolvedItem[] = [];
    let evictableTokens = 0;

    // Walk evictable items from oldest to newest. We want to keep as many
    // older items as the budget allows; once we exceed the budget we start
    // dropping the *oldest* items. To achieve this we first compute the
    // total, then trim from the front.
    const evictableTotalTokens = evictable.reduce((sum, it) => sum + it.tokens, 0);

    if (evictableTotalTokens <= remainingBudget) {
      // Everything fits
      selected.push(...evictable);
      evictableTokens = evictableTotalTokens;
    } else {
      // Need to drop oldest items until we fit.
      // Walk from the END of evictable (newest first) accumulating tokens,
      // then reverse to restore chronological order.
      const kept: ResolvedItem[] = [];
      let accum = 0;
      for (let i = evictable.length - 1; i >= 0; i--) {
        const item = evictable[i];
        if (accum + item.tokens <= remainingBudget) {
          kept.push(item);
          accum += item.tokens;
        } else {
          // Once an item doesn't fit we stop — all older items are also dropped
          break;
        }
      }
      kept.reverse();
      selected.push(...kept);
      evictableTokens = accum;
    }

    // Ozempic: provenance-aware eviction.
    // Find tool names that produced mutations in the fresh tail.
    // Evict older observed results from the same tools (they are stale).
    let evictedStaleObserved = 0;
    if (provenanceEviction && provenanceTyping) {
      const mutatedTools = new Set<string>();
      for (const item of freshTail) {
        if (item.provenance === "mutation" && item.toolName) {
          mutatedTools.add(item.toolName);
        }
      }
      if (mutatedTools.size > 0) {
        const beforeEviction = selected.length;
        selected = selected.filter((item) => {
          if (item.provenance === "observed" && item.toolName && mutatedTools.has(item.toolName)) {
            evictedStaleObserved++;
            evictableTokens -= item.tokens;
            return false;
          }
          return true;
        });
        evictedStaleObserved = beforeEviction - selected.length;
      }
    }

    // Ozempic Tier 3: freshness TTL eviction.
    // Evict observed results from the evictable pool that are past their TTL.
    // Items in the fresh tail are always preserved regardless of TTL.
    if (contextPolicy?.freshnessTtl && provenanceTyping) {
      selected = selected.filter((item) => {
        if (
          item.provenance === "observed" &&
          isFreshnessExpired(item.createdAt, item.toolName, contextPolicy)
        ) {
          evictableTokens -= item.tokens;
          return false;
        }
        return true;
      });
    }

    // Ozempic: acknowledgment pruning.
    // Scan the evictable portion for low-value (user, assistant) pairs:
    // tiny assistant messages with no tool calls (e.g. "Sure!", "Got it.").
    // Removing them frees budget for real content without losing signal.
    let ackPruned = 0;
    if (ackPruning && selected.length > 1) {
      const ackIndices = new Set<number>();
      for (let i = 1; i < selected.length; i++) {
        const prev = selected[i - 1];
        const curr = selected[i];
        if (
          curr.dbRole === "assistant" &&
          !hasToolContent(curr.message) &&
          curr.tokens <= ackPruningMaxTokens &&
          prev.dbRole === "user" &&
          !hasToolContent(prev.message)
        ) {
          ackIndices.add(i - 1);
          ackIndices.add(i);
        }
      }
      if (ackIndices.size > 0) {
        selected = selected.filter((_, idx) => !ackIndices.has(idx));
        ackPruned = ackIndices.size;
      }
    }

    // Append fresh tail after the evictable prefix
    selected.push(...freshTail);

    const estimatedTokens = evictableTokens + tailTokens;

    // Normalize assistant string content to array blocks (some providers return
    // content as a plain string; Anthropic expects content block arrays).
    const rawMessages = selected.map((item) => item.message);
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      if (msg?.role === "assistant" && typeof msg.content === "string") {
        rawMessages[i] = {
          ...msg,
          content: [{ type: "text", text: msg.content }] as unknown as typeof msg.content,
        } as typeof msg;
      }
    }

    // Ozempic: reasoning trace drop.
    // Strip thinking/reasoning blocks from non-fresh-tail assistant messages
    // to reclaim tokens wasted on prior-turn deliberation.
    if (reasoningTraceMode === "drop") {
      for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i];
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const filtered = (msg.content as Array<{ type?: string }>).filter(
            (block) => block.type !== "thinking" && block.type !== "reasoning",
          );
          if (filtered.length !== (msg.content as unknown[]).length) {
            rawMessages[i] = { ...msg, content: filtered as typeof msg.content } as typeof msg;
          }
        }
      }
    }

    // Ozempic: tool result compaction (Tier 3 rules + Tier 2 cap fallback).
    // Tier 3 compaction rules take priority: field extraction + per-rule maxTokens.
    // Falls back to Tier 2 toolResultCap truncation when no rule matches.
    // Runs whenever either Tier 2 cap is set OR Tier 3 rules are present.
    const hasCompactionRules = (contextPolicy?.toolResultCompaction?.rules?.length ?? 0) > 0;
    if (toolResultCap > 0 || hasCompactionRules) {
      for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i];
        if (msg?.role === "toolResult" && Array.isArray(msg.content)) {
          const toolName = (msg as { toolName?: string }).toolName ?? "";
          const capped = (msg.content as Array<unknown>).map((block) => {
            if (!block || typeof block !== "object") return block;
            const b = block as { type?: string; output?: unknown; text?: string };
            const text =
              typeof b.output === "string"
                ? b.output
                : typeof b.text === "string"
                  ? b.text
                  : null;
            if (text === null) return block;
            const compacted = applyCompactionRules(toolName, text, contextPolicy, toolResultCap);
            if (compacted === text) return block;
            if (typeof b.output === "string") return { ...b, output: compacted };
            return { ...b, text: compacted };
          });
          rawMessages[i] = { ...msg, content: capped as typeof msg.content } as typeof msg;
        }
      }
    }

    // Ozempic: build manifest items when provenance typing is enabled
    let manifestItems: ManifestItem[] | undefined;
    if (provenanceTyping) {
      const freshTailOrdinals = new Set(freshTail.map((it) => it.ordinal));
      manifestItems = selected.map((item): ManifestItem => ({
        ordinal: item.ordinal,
        sourceType: item.isMessage ? "message" : "summary",
        runtimeRole: item.message.role,
        estimatedTokens: item.tokens,
        provenance: item.provenance
          ? { kind: item.provenance, ...(item.toolName ? { toolName: item.toolName } : {}) }
          : undefined,
        protectedByFreshTail: freshTailOrdinals.has(item.ordinal),
      }));
    }

    let sanitized = sanitizeToolUseResultPairing(rawMessages) as AgentMessage[];

    // Ozempic Tier 3: inject session state block as the first message.
    // Prepended after all assembly/pruning so it is never itself pruned.
    const { sessionStateBlock } = input;
    if (sessionStateBlock && sessionStateBlock.trim()) {
      sanitized = [
        { role: "user", content: sessionStateBlock } as AgentMessage,
        ...sanitized,
      ];
    }

    return {
      messages: sanitized,
      estimatedTokens,
      systemPromptAddition,
      stats: {
        rawMessageCount,
        summaryCount,
        totalContextItems: resolved.length,
        freshTailTrimmed,
        evictedStaleObserved,
        ackPruned,
      },
      manifestItems,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Resolve a list of context items into ResolvedItems by fetching the
   * underlying message or summary record for each.
   *
   * Items that cannot be resolved (e.g. deleted message) are silently skipped.
   */
  private async resolveItems(contextItems: ContextItemRecord[]): Promise<ResolvedItem[]> {
    const resolved: ResolvedItem[] = [];

    for (const item of contextItems) {
      const result = await this.resolveItem(item);
      if (result) {
        resolved.push(result);
      }
    }

    return resolved;
  }

  /**
   * Resolve a single context item.
   */
  private async resolveItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    if (item.itemType === "message" && item.messageId != null) {
      return this.resolveMessageItem(item);
    }

    if (item.itemType === "summary" && item.summaryId != null) {
      return this.resolveSummaryItem(item);
    }

    // Malformed item — skip
    return null;
  }

  /**
   * Resolve a context item that references a raw message.
   */
  private async resolveMessageItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const msg = await this.conversationStore.getMessageById(item.messageId!);
    if (!msg) {
      return null;
    }

    const parts = await this.conversationStore.getMessageParts(msg.messageId);
    const roleFromStore = toRuntimeRole(msg.role, parts);
    const isToolResult = roleFromStore === "toolResult";
    const toolCallId = isToolResult ? pickToolCallId(parts) : undefined;
    const toolName = isToolResult ? (pickToolName(parts) ?? "unknown") : undefined;
    const toolIsError = isToolResult ? pickToolIsError(parts) : undefined;
    // Tool results without a call id cannot be serialized for Anthropic-compatible APIs.
    // This happens for legacy/bootstrap rows that have role=tool but no message_parts.
    // Preserve the text by degrading to assistant content instead of emitting invalid toolResult.
    const role: "user" | "assistant" | "toolResult" =
      isToolResult && !toolCallId ? "assistant" : roleFromStore;
    const content = contentFromParts(parts, role, msg.content);
    const contentText =
      typeof content === "string" ? content : (JSON.stringify(content) ?? msg.content);
    const tokenCount = msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(contentText);

    // Cast: these are reconstructed from DB storage, not live agent messages,
    // so they won't carry the full AgentMessage metadata (timestamp, usage, etc.)
    return {
      ordinal: item.ordinal,
      message:
        role === "assistant"
          ? ({
              role,
              content,
              usage: {
                input: 0,
                output: tokenCount,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: tokenCount,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            } as AgentMessage)
          : ({
              role,
              content,
              ...(toolCallId ? { toolCallId } : {}),
              ...(toolName ? { toolName } : {}),
              ...(role === "toolResult" && toolIsError !== undefined ? { isError: toolIsError } : {}),
            } as AgentMessage),
      tokens: tokenCount,
      isMessage: true,
      dbRole: msg.role,
      toolName: toolName ?? undefined,
      createdAt: msg.createdAt,
    };
  }

  /**
   * Resolve a context item that references a summary.
   * Summaries are presented as user messages with a structured XML wrapper.
   */
  private async resolveSummaryItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const summary = await this.summaryStore.getSummary(item.summaryId!);
    if (!summary) {
      return null;
    }

    const content = await formatSummaryContent(summary, this.summaryStore, this.timezone);
    const tokens = estimateTokens(content);

    // Cast: summaries are synthetic user messages without full AgentMessage metadata
    return {
      ordinal: item.ordinal,
      message: { role: "user" as const, content } as AgentMessage,
      tokens,
      isMessage: false,
      summarySignal: {
        kind: summary.kind,
        depth: summary.depth,
        descendantCount: summary.descendantCount,
      },
    };
  }
}
