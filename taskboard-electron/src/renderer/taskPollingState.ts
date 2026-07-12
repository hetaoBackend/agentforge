const MUTABLE_TASK_SUMMARY_FIELDS = [
  "title",
  "status",
  "schedule_type",
  "cron_expr",
  "delay_seconds",
  "next_run_at",
  "last_run_at",
  "run_count",
  "max_runs",
  "tags",
  "agent",
  "dag_id",
] as const;

/**
 * Refresh volatile scalar fields without replacing detail-only payloads.
 * In particular, summary dependencies intentionally contain fewer fields than
 * the full task response and must never overwrite full dependency metadata.
 */
export function mergeTaskSummaryIntoDetail(
  detail: Record<string, any> | null,
  summary: Record<string, any> | undefined,
): Record<string, any> | null {
  if (!detail || !summary || detail.id !== summary.id) return detail;

  const merged = { ...detail };
  for (const field of MUTABLE_TASK_SUMMARY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(summary, field)) {
      merged[field] = summary[field];
    }
  }
  return merged;
}

export interface DetailRequestToken {
  generation: number;
  signal: AbortSignal;
}

export class DetailRequestCoordinator {
  private generation = 0;
  private controller: AbortController | null = null;

  begin(): DetailRequestToken {
    this.controller?.abort();
    this.controller = new AbortController();
    return {
      generation: ++this.generation,
      signal: this.controller.signal,
    };
  }

  isCurrent(token: DetailRequestToken): boolean {
    return token.generation === this.generation && !token.signal.aborted;
  }

  invalidate(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }
}

export async function loadLatestTaskDetail(
  taskId: number,
  coordinator: DetailRequestCoordinator,
  fetchTask: (taskId: number, signal: AbortSignal) => Promise<Record<string, any>>,
  onLoaded: (task: Record<string, any>) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const token = coordinator.begin();
  try {
    const task = await fetchTask(taskId, token.signal);
    if (coordinator.isCurrent(token)) onLoaded(task);
  } catch (error) {
    if (coordinator.isCurrent(token)) onError(error);
  }
}
