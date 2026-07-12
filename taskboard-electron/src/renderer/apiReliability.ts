function responseErrorMessage(response: Response, payload: unknown, rawBody: string): string {
  if (payload && typeof payload === "object") {
    for (const key of ["error", "message", "detail"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }

  if (rawBody.trim()) return rawBody.trim();
  return response.statusText || `HTTP ${response.status}`;
}

/**
 * Reads an API response exactly once, preserving empty and non-JSON success
 * bodies while turning every non-2xx response into a useful exception.
 */
export async function parseApiResponse<T = unknown>(response: Response): Promise<T> {
  const rawBody = await response.text();
  let payload: unknown = undefined;

  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = rawBody;
    }
  }

  if (!response.ok) {
    throw new Error(responseErrorMessage(response, payload, rawBody));
  }

  return payload as T;
}

export interface RequestGenerationGuard {
  begin(): number;
  isCurrent(generation: number): boolean;
  invalidate(): void;
}

/** Tracks overlapping request rounds so only the newest round may commit. */
export function createRequestGenerationGuard(): RequestGenerationGuard {
  let currentGeneration = 0;

  return {
    begin() {
      currentGeneration += 1;
      return currentGeneration;
    },
    isCurrent(generation) {
      return generation === currentGeneration;
    },
    invalidate() {
      currentGeneration += 1;
    },
  };
}
