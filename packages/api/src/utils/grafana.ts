import logger from '@/utils/logger';

export type GrafanaOrg = {
  id: number;
  name: string;
};

/**
 * Get Grafana credentials from environment variables
 */
function getGrafanaCredentials(): {
  username: string;
  token: string;
  url: string;
} | null {
  const username = process.env.GRAFANA_USER;
  const token = process.env.GRAFANA_TOKEN;
  const url =
    process.env.GRAFANA_URL || 'https://grafana.k8s.metabit-trading.com';

  if (!username || !token) {
    return null;
  }

  return { username, token, url };
}

/**
 * Fetch data from Grafana API
 */
async function fetchGrafana<T>(
  path: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    logger.error('Grafana API error:', response.status, response.statusText);
    throw new Error(`Grafana API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Fetch all Grafana organizations
 */
export async function fetchGrafanaOrgs(): Promise<GrafanaOrg[]> {
  const credentials = getGrafanaCredentials();

  if (!credentials) {
    throw new Error('Grafana credentials not configured');
  }

  const authHeader = Buffer.from(
    `${credentials.username}:${credentials.token}`,
  ).toString('base64');

  const orgs = await fetchGrafana<GrafanaOrg[]>(
    `${credentials.url}/api/orgs`,
    {
    Authorization: `Basic ${authHeader}`,
  });

  return orgs;
}
