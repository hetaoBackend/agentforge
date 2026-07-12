export interface IncrementalOutputPayload {
  output?: string;
  next_offset?: number;
  reset?: boolean;
}

export interface IncrementalOutputState {
  output: string;
  nextOffset: number;
}

export function createIncrementalOutputState(): IncrementalOutputState {
  return { output: "", nextOffset: 0 };
}

/**
 * Apply one offset-based output response.
 *
 * A reset is required when the backend's buffer was replaced or shortened.
 * Treat a backwards next offset as a reset as well, so a malformed/stale
 * response cannot leave unrelated output attached to the current task.
 */
export function applyIncrementalOutput(
  currentOutput: string,
  requestedOffset: number,
  payload: IncrementalOutputPayload,
): IncrementalOutputState {
  const chunk = typeof payload.output === "string" ? payload.output : "";
  const reportedOffset =
    typeof payload.next_offset === "number" &&
    Number.isFinite(payload.next_offset) &&
    payload.next_offset >= 0
      ? payload.next_offset
      : requestedOffset + chunk.length;
  const reset = payload.reset === true || reportedOffset < requestedOffset;

  return {
    output: reset ? chunk : currentOutput + chunk,
    nextOffset: reportedOffset,
  };
}
