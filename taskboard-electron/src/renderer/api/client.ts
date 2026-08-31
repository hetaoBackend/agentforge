/**
 * REST client for the local backend.
 *
 * Extracted verbatim from App.tsx — same endpoints, same request shapes, same
 * error behaviour. `API` is the loopback base the Electrobun host serves on.
 */

export const API = "http://127.0.0.1:9712/api";

// ─── CSRF token ───
// Fetched once at startup; reused for all state-changing requests.
let _csrfTokenPromise = null;
function getCsrfToken() {
  if (!_csrfTokenPromise) {
    _csrfTokenPromise = fetch(`${API}/csrf-token`)
      .then((r) => r.json())
      .then((d) => d.csrf_token || "")
      .catch(() => "");
  }
  return _csrfTokenPromise;
}

async function csrfHeaders(extra = {}) {
  const token = await getCsrfToken();
  return { "Content-Type": "application/json", "X-CSRF-Token": token, ...extra };
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  timeoutMs: number,
  init: RequestInit = {},
) {
  if (typeof AbortController === "undefined") {
    let timeout = 0;
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
    });
    try {
      return await Promise.race([fetch(input, init), timeoutPromise]);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

// ─── API helpers ───
export async function fetchTasks() {
  const res = await fetch(`${API}/tasks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchHeartbeats() {
  const res = await fetch(`${API}/heartbeats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createTask(data) {
  const res = await fetch(`${API}/tasks`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function fetchSkillPatterns() {
  const res = await fetch(`${API}/skill-patterns`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function triggerSkillSweep(agent?: string) {
  const res = await fetch(`${API}/skills/sweep`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(agent ? { agent } : {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function triggerSkillDraft(id, agent?: string) {
  const res = await fetch(`${API}/skill-patterns/${id}/draft`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(agent ? { agent } : {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function approveSkill(id, data) {
  const res = await fetch(`${API}/skill-patterns/${id}/approve`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function dismissSkillPattern(id) {
  const res = await fetch(`${API}/skill-patterns/${id}/dismiss`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: "{}",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function fetchSkills() {
  const res = await fetch(`${API}/skills`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function setSkillEnabledApi(id, enabled) {
  const res = await fetch(`${API}/skills/${id}`, {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify({ enabled }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function deleteSkillApi(id) {
  const res = await fetch(`${API}/skills/${id}`, {
    method: "DELETE",
    headers: await csrfHeaders(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function createHeartbeat(data) {
  const res = await fetch(`${API}/heartbeats`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function updateHeartbeat(id, data) {
  const res = await fetch(`${API}/heartbeats/${id}`, {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function deleteHeartbeat(id) {
  const res = await fetch(`${API}/heartbeats/${id}`, {
    method: "DELETE",
    headers: await csrfHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function runHeartbeatNow(id) {
  const res = await fetch(`${API}/heartbeats/${id}/run-now`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function pauseHeartbeat(id) {
  const res = await fetch(`${API}/heartbeats/${id}/pause`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function resumeHeartbeatApi(id) {
  const res = await fetch(`${API}/heartbeats/${id}/resume`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export async function fetchHeartbeatTicks(id) {
  const res = await fetch(`${API}/heartbeats/${id}/ticks?limit=20`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  return payload.ticks || [];
}

export async function fetchHeartbeatTickOutput(heartbeatId, tickId) {
  const res = await fetch(`${API}/heartbeats/${heartbeatId}/ticks/${tickId}/output`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function cancelTask(id) {
  await fetch(`${API}/tasks/${id}/cancel`, { method: "POST", headers: await csrfHeaders() });
}

export async function retryTask(id) {
  await fetch(`${API}/tasks/${id}/retry`, { method: "POST", headers: await csrfHeaders() });
}

export async function deleteTask(id) {
  await fetch(`${API}/tasks/${id}`, { method: "DELETE", headers: await csrfHeaders() });
}

export async function updateTask(id, data) {
  const res = await fetch(`${API}/tasks/${id}`, {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function respondToTask(id, answer) {
  await fetch(`${API}/tasks/${id}/respond`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ answer }),
  });
}

export async function resumeTask(id, message) {
  const res = await fetch(`${API}/tasks/${id}/resume`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ message }),
  });
  return res.json();
}

export async function fetchTaskMessages(id) {
  try {
    const res = await fetch(`${API}/tasks/${id}/messages`);
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function fetchTaskEvents(id) {
  try {
    const res = await fetch(`${API}/tasks/${id}/events?limit=1000`);
    if (res.ok) {
      const data = await res.json();
      return data.events || [];
    }
    return [];
  } catch {
    return [];
  }
}

export async function fetchSettings() {
  try {
    const res = await fetch(`${API}/settings`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

export async function updateSettings(data) {
  await fetch(`${API}/settings`, {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

export async function fetchFeishuSettings() {
  try {
    const res = await fetch(`${API}/feishu/settings`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

export async function updateFeishuSettings(data) {
  await fetch(`${API}/feishu/settings`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

export async function fetchChannelsStatus() {
  try {
    const res = await fetch(`${API}/channels/status`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

export async function updateChannelsSettings(data) {
  await fetch(`${API}/channels/settings`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

export async function runWeixinAction(action) {
  const res = await fetch(`${API}/channels/weixin/action`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}
