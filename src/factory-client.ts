const FACTORY_API_BASE = process.env.FACTORY_API_BASE ?? "https://api.factory.ai/api/v0";
const FACTORY_API_KEY = process.env.FACTORY_API_KEY ?? "";

interface FactorySession {
  id: string;
  status: string;
  model: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

interface FactoryMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface FactoryMission {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

interface FactoryCreateMissionInput {
  title: string;
  description: string;
  repository?: string;
  branch?: string;
}

async function factoryRequest<T>(path: string, options?: RequestInit): Promise<T> {
  if (!FACTORY_API_KEY) {
    throw new Error("FACTORY_API_KEY is not configured");
  }
  const url = `${FACTORY_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${FACTORY_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Factory API ${res.status} (${path}): ${body.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

export async function listSessions(limit = 10): Promise<FactorySession[]> {
  const result = await factoryRequest<{ sessions?: FactorySession[] }>(`/sessions?limit=${limit}`);
  return result.sessions ?? [];
}

export async function getSession(sessionId: string): Promise<FactorySession> {
  return factoryRequest<FactorySession>(`/sessions/${sessionId}`);
}

export async function getSessionMessages(sessionId: string, limit = 50): Promise<FactoryMessage[]> {
  const result = await factoryRequest<{ messages?: FactoryMessage[] }>(`/sessions/${sessionId}/messages?limit=${limit}`);
  return result.messages ?? [];
}

export async function createMission(input: FactoryCreateMissionInput): Promise<FactoryMission> {
  return factoryRequest<FactoryMission>("/missions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
