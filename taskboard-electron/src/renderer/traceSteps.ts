export const TRACE_EVENT_TYPES = new Set([
  "tool_call",
  "tool_result",
  "command_execution",
  "file_change",
  "web_search",
]);

const THINKING_PREFIX = "[thinking] ";

export interface TraceRow {
  label: string;
  value: string;
}

export type TracePayload = Record<string, any>;

export interface TraceEventInput {
  id?: number;
  event_type?: string;
  type?: string;
  content?: string;
  timestamp?: string;
}

export interface ExecutionStep {
  id: string;
  eventIds: number[];
  rawEventType: string;
  timestamp: string;
  rows: TraceRow[];
  detail: string;
  count: number;
  type: string;
  title: string;
  imageSrc?: string;
  number?: number;
}

function compact(rows: Array<TraceRow | null>): TraceRow[] {
  return rows.filter(Boolean) as TraceRow[];
}

function row(label: string, value: unknown): TraceRow | null {
  const formatted = formatTraceValue(value);
  return formatted === "" ? null : { label, value: formatted };
}

export function parseTracePayload(content: string): TracePayload | null {
  try {
    const payload = JSON.parse(content);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function formatTraceValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function buildTraceRows(
  eventType: string,
  payload: TracePayload,
  rawContent = "",
): TraceRow[] {
  if (eventType === "tool_call") {
    const name = payload.server
      ? `${payload.server}.${payload.name || payload.tool || "unknown"}`
      : payload.name || payload.tool || "unknown";
    return compact([
      row("Tool", name),
      row("Input", payload.input || payload.arguments),
      row("Result", payload.result),
      row("Status", payload.status),
      row("Error", payload.error),
    ]);
  }

  if (eventType === "tool_result") {
    return compact([
      row(payload.is_error ? "Tool Error" : "Tool Result", payload.tool_use_id || "result"),
      row("Content", payload.content),
    ]);
  }

  if (eventType === "command_execution") {
    return compact([
      row("Command", payload.command),
      row("Output", payload.output),
      row("Exit", payload.exit_code),
      row("Status", payload.status),
    ]);
  }

  if (eventType === "file_change") {
    const changes = Array.isArray(payload.changes)
      ? payload.changes
          .map((change: any) => {
            if (!change || typeof change !== "object") return formatTraceValue(change);
            const kind = change.kind || change.type || "changed";
            const path = change.path || change.file || "";
            return path ? `${kind}: ${path}` : kind;
          })
          .join("\n")
      : payload.changes;
    return compact([row("Changes", changes), row("Status", payload.status)]);
  }

  if (eventType === "web_search") {
    return compact([
      row("Query", payload.query),
      row("Action", payload.action),
      row("Status", payload.status),
    ]);
  }

  return [{ label: eventType, value: rawContent }];
}

export function buildExecutionSteps(events: TraceEventInput[] | null | undefined): ExecutionStep[] {
  const sortedEvents = [...(events || [])].sort(compareEventsChronologically);
  const steps: ExecutionStep[] = [];

  for (const event of sortedEvents) {
    const step = eventToStep(event);
    if (!step) continue;

    const previous = steps[steps.length - 1];
    if (canMergeSteps(previous, step)) {
      previous.detail = appendDetail(previous.detail, step.detail);
      previous.title = summarizeTitle(previous.detail) || previous.title;
      previous.eventIds.push(...step.eventIds);
      previous.count += step.count;
      previous.timestamp = step.timestamp;
      continue;
    }

    steps.push(step);
  }

  return steps.map((step, index) => ({
    ...step,
    number: index + 1,
  }));
}

function compareEventsChronologically(a: TraceEventInput, b: TraceEventInput): number {
  const timestampComparison = String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
  if (timestampComparison !== 0) return timestampComparison;
  return Number(a.id || 0) - Number(b.id || 0);
}

function eventToStep(event: TraceEventInput): ExecutionStep | null {
  const eventType = event.event_type || event.type || "unknown";
  const content = event.content || "";
  const base = {
    id: event.id ? `event-${event.id}` : `${eventType}-${event.timestamp || ""}-${content.length}`,
    eventIds: event.id ? [event.id] : [],
    rawEventType: eventType,
    timestamp: event.timestamp || "",
    rows: [] as TraceRow[],
    detail: content,
    count: 1,
  };

  if (eventType === "assistant") {
    if (content.startsWith(THINKING_PREFIX)) {
      const detail = content.slice(THINKING_PREFIX.length);
      return {
        ...base,
        type: "thinking",
        title: summarizeTitle(detail) || "Thinking",
        detail,
      };
    }
    return {
      ...base,
      type: "assistant",
      title: summarizeTitle(content) || "Assistant message",
    };
  }

  if (eventType === "user") {
    return {
      ...base,
      type: "user",
      title: summarizeTitle(content) || "User message",
    };
  }

  if (eventType === "result") {
    return {
      ...base,
      type: "result",
      title: summarizeTitle(content, "Result") || "Result",
    };
  }

  if (eventType === "error") {
    return {
      ...base,
      type: "error",
      title: summarizeTitle(content, "Error") || "Error",
    };
  }

  if (eventType === "image_content") {
    const payload = parseTracePayload(content) || {};
    const mediaType = payload.media_type || "image/jpeg";
    const imageSrc = payload.data ? `data:${mediaType};base64,${payload.data}` : "";
    return {
      ...base,
      type: "image_content",
      title: "Image output",
      rows: compact([row("Media", mediaType)]),
      detail: "[image]",
      imageSrc,
    };
  }

  if (eventType === "generated_image") {
    const payload = parseTracePayload(content) || { content };
    const imagePath = payload.path || payload.content || "";
    return {
      ...base,
      type: "generated_image",
      title: imagePath ? `Generated image: ${basename(imagePath)}` : "Generated image",
      rows: compact([row("Path", imagePath), row("Media", payload.media_type)]),
      detail: imagePath,
    };
  }

  if (!TRACE_EVENT_TYPES.has(eventType)) {
    return {
      ...base,
      type: "event",
      title: summarizeTitle(content, eventType) || eventType,
    };
  }

  const payload = parseTracePayload(content) || { content };
  const rows = buildTraceRows(eventType, payload, content);
  return {
    ...base,
    type: eventType,
    title: titleForTraceEvent(eventType, payload),
    rows,
    detail: rows.map((item) => `${item.label}: ${item.value}`).join("\n"),
  };
}

function titleForTraceEvent(eventType: string, payload: TracePayload): string {
  if (eventType === "tool_call") {
    const name = payload.server
      ? `${payload.server}.${payload.name || payload.tool || "unknown"}`
      : payload.name || payload.tool || "unknown";
    return `Call tool: ${name}`;
  }

  if (eventType === "tool_result") {
    const label = payload.is_error ? "Tool error" : "Tool result";
    return `${label}: ${payload.tool_use_id || "result"}`;
  }

  if (eventType === "command_execution") {
    return `Run command: ${payload.command || payload.content || "command"}`;
  }

  if (eventType === "web_search") {
    return `Search web: ${payload.query || payload.content || "query"}`;
  }

  if (eventType === "file_change") {
    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    const firstPath = changes.find(
      (change: any) => change && typeof change === "object" && (change.path || change.file),
    );
    return firstPath ? `Change file: ${firstPath.path || firstPath.file}` : "Change files";
  }

  return eventType;
}

function canMergeSteps(previous: ExecutionStep | undefined, next: ExecutionStep): boolean {
  return Boolean(
    previous &&
    previous.type === next.type &&
    (next.type === "thinking" || next.type === "assistant") &&
    previous.rawEventType === next.rawEventType,
  );
}

function appendDetail(previous: string, next: string): string {
  if (!previous) return next || "";
  if (!next) return previous;
  if (
    previous.endsWith("\n") ||
    previous.endsWith(" ") ||
    next.startsWith("\n") ||
    next.startsWith(" ")
  ) {
    return previous + next;
  }
  return `${previous}\n${next}`;
}

function summarizeTitle(text: unknown, prefix = ""): string {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return prefix;
  const title = normalized.length > 120 ? `${normalized.slice(0, 117).trim()}...` : normalized;
  return prefix ? `${prefix}: ${title}` : title;
}

function basename(value: unknown): string {
  const parts = String(value || "")
    .split(/[\\/]/)
    .filter(Boolean);
  return parts[parts.length - 1] || String(value || "");
}
