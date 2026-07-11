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

type TaskWithResponse = {
  id: TickId;
  question?: unknown;
  answer?: unknown;
};

type TargetedTaskRefreshOptions<T> = {
  load: () => Promise<T>;
  onTask: (task: T) => void;
  onError: (error: unknown) => void;
};

export type TaskResponseRefreshResult = {
  refreshed: boolean;
};

export type TaskResponseUiState = "hidden" | "form" | "submitted" | "submitted-stale";

export function taskNeedsResponse(question: unknown, answer: unknown): boolean {
  return typeof question === "string" && question.trim().length > 0 && !String(answer ?? "").trim();
}

export function getTaskResponseUiState(
  question: unknown,
  answer: unknown,
  result: TaskResponseRefreshResult | null,
): TaskResponseUiState {
  if (!taskNeedsResponse(question, answer)) return "hidden";
  if (!result) return "form";
  return result.refreshed ? "submitted" : "submitted-stale";
}

export function markTaskResponseSubmitted<T extends TaskWithResponse>(
  task: T,
  taskId: TickId,
  answer: string,
): T {
  if (task.id !== taskId) return task;
  return { ...task, question: null, answer };
}

export function reconcileTasksWithSubmittedAnswers<T extends TaskWithResponse>(
  tasks: T[],
  submittedAnswers: Readonly<Record<string, string>>,
): { tasks: T[]; pendingSubmissionIds: string[] } {
  const pendingSubmissionIds: string[] = [];
  const reconciled = tasks.map((task) => {
    const key = String(task.id);
    if (!Object.hasOwn(submittedAnswers, key) || !taskNeedsResponse(task.question, task.answer)) {
      return task;
    }
    pendingSubmissionIds.push(key);
    return markTaskResponseSubmitted(task, task.id, submittedAnswers[key]);
  });
  return { tasks: reconciled, pendingSubmissionIds };
}

export function mergeTargetedTaskDetail<T extends TaskWithResponse>(
  currentDetail: T | null,
  requestedTaskId: TickId,
  refreshedTask: T,
): T | null {
  return currentDetail?.id === requestedTaskId ? refreshedTask : currentDetail;
}

export async function attemptTargetedTaskRefresh<T>({
  load,
  onTask,
  onError,
}: TargetedTaskRefreshOptions<T>): Promise<boolean> {
  try {
    onTask(await load());
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
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
