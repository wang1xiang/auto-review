import { HttpsProxyAgent } from 'https-proxy-agent';

function getAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

async function fetchWithAgent<T>(url: string, options: { method?: string; body?: string; headers?: Record<string, string> }): Promise<T> {
  const { method = 'GET', body, headers = {} } = options;

  const agent = getAgent();
  const urlObj = new URL(url);
  const protocol = urlObj.protocol === 'https:' ? await import('node:https') : await import('node:http');

  return new Promise((resolve, reject) => {
    const req = protocol.request(url, {
      method,
      headers,
      agent,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        } else {
          resolve(JSON.parse(data) as T);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export interface GitLabClientOptions {
  baseUrl: string;
  token: string;
  projectId: string;
}

export class GitLabClient {
  private baseUrl: string;
  private projectId: string;
  private headers: Record<string, string>;

  constructor({ baseUrl, token, projectId }: GitLabClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.projectId = encodeURIComponent(projectId);
    this.headers = { 'PRIVATE-TOKEN': token };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`;
    const headers = body
      ? { ...this.headers, 'Content-Type': 'application/json' }
      : this.headers;

    return fetchWithAgent<T>(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async getMr(iid: number) {
    return this.request<{
      iid: number;
      title: string;
      source_branch: string;
      target_branch: string;
      state: string;
      work_in_progress: boolean;
    }>('GET', `/projects/${this.projectId}/merge_requests/${iid}`);
  }

  async getMrChanges(iid: number) {
    return this.request<{ changes: Array<{ old_path: string; new_path: string; diff: string }> }>(
      'GET',
      `/projects/${this.projectId}/merge_requests/${iid}/changes`,
    );
  }

  async getMrDiffText(iid: number): Promise<string> {
    const data = await this.getMrChanges(iid);
    return data.changes
      .filter((c) => c.diff)
      .map((c) => `--- ${c.old_path || 'dev/null'}\n+++ ${c.new_path || 'dev/null'}\n${c.diff}`)
      .join('\n\n');
  }

  async getMrNotes(iid: number) {
    return this.request<Array<{ id: number; body: string; created_at: string }>>(
      'GET',
      `/projects/${this.projectId}/merge_requests/${iid}/notes`,
    );
  }

  async postNote(iid: number, body: string) {
    return this.request<{ id: number }>(
      'POST',
      `/projects/${this.projectId}/merge_requests/${iid}/notes`,
      { body },
    );
  }

  async listOpenMrs() {
    return this.request<Array<{ iid: number; title: string; source_branch: string; target_branch: string }>>(
      'GET',
      `/projects/${this.projectId}/merge_requests?state=opened`,
    );
  }

  async testConnection(): Promise<boolean> {
    try {
      const project = await this.request<{ name: string; path_with_namespace: string }>(
        'GET',
        `/projects/${this.projectId}`,
      );
      console.log(`GitLab 连接成功: ${project.name} (${project.path_with_namespace})`);
      return true;
    } catch (e) {
      console.error(`GitLab 连接失败: ${e}`);
      return false;
    }
  }
}
