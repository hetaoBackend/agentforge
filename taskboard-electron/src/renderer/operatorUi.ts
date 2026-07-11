export type TickId = string | number;

type TickWithId = {
  id: TickId;
};

type HeartbeatTickPollingOptions<T> = {
  heartbeatId: TickId;
  load: (heartbeatId: TickId) => Promise<T>;
  onTicks: (ticks: T) => void;
  onError: (error: unknown) => void;
  intervalMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancelScheduled?: (timer: unknown) => void;
};

export function taskNeedsResponse(question: unknown, answer: unknown): boolean {
  return (
    typeof question === "string" &&
    question.trim().length > 0 &&
    !String(answer ?? "").trim()
  );
}

export function prepareTaskResponse(
  value: string,
): { answer: string; error: null } | { answer: null; error: string } {
  const answer = value.trim();
  if (!answer) {
    return { answer: null, error: "Please enter an answer before submitting." };
  }
  return { answer, error: null };
}

export function selectTickAfterRefresh(
  selectedTickId: TickId | null,
  ticks: TickWithId[],
  heartbeatChanged = false,
): TickId | null {
  if (ticks.length === 0) return null;
  if (!heartbeatChanged && ticks.some((tick) => tick.id === selectedTickId)) {
    return selectedTickId;
  }
  return ticks[0].id;
}

export function startHeartbeatTickPolling<T>({
  heartbeatId,
  load,
  onTicks,
  onError,
  intervalMs = 2000,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelScheduled = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: HeartbeatTickPollingOptions<T>): () => void {
  let active = true;
  let timer: unknown;

  const refresh = async () => {
    try {
      const ticks = await load(heartbeatId);
      if (active) onTicks(ticks);
    } catch (error) {
      if (active) onError(error);
    } finally {
      if (active) timer = schedule(refresh, intervalMs);
    }
  };

  void refresh();
  return () => {
    active = false;
    if (timer !== undefined) cancelScheduled(timer);
  };
}
