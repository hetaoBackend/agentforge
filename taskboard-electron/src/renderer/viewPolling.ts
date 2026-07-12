export type MainView = "home" | "tasks" | "heartbeats" | "skills";

export interface MainViewData {
  tasks?: any[];
  heartbeats?: any[];
  skillData?: any;
  skills?: any[];
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function getJson(fetchImpl: FetchLike, url: string): Promise<any> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Fetch only the data required by the visible top-level view.
 * Skills also needs lightweight task summaries to label contributing tasks.
 */
export async function fetchMainViewData(
  activeView: MainView,
  apiBase: string,
  fetchImpl: FetchLike = fetch,
): Promise<MainViewData> {
  if (activeView === "home") {
    return {};
  }
  if (activeView === "tasks") {
    return { tasks: await getJson(fetchImpl, `${apiBase}/tasks?mode=summary`) };
  }
  if (activeView === "heartbeats") {
    return { heartbeats: await getJson(fetchImpl, `${apiBase}/heartbeats`) };
  }

  const [skillData, skillsResponse, tasks] = await Promise.all([
    getJson(fetchImpl, `${apiBase}/skill-patterns`),
    getJson(fetchImpl, `${apiBase}/skills`),
    getJson(fetchImpl, `${apiBase}/tasks?mode=summary`),
  ]);
  return {
    skillData,
    skills: skillsResponse.skills || [],
    tasks,
  };
}
