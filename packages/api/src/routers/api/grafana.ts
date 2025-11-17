import express from 'express';

import logger from '@/utils/logger';
import { fetchGrafanaOrgs } from '@/utils/grafana';

const router = express.Router();

async function fetchGrafana<T>(path: string, headers: Record<string, string>) {
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

router.get('/orgs', async (_req, res) => {
  try {
    const data = await fetchGrafanaOrgs();
    return res.status(200).json(data);
  } catch (error) {
    logger.error('Error fetching Grafana orgs:', error);
    return res.status(500).json({
      error: 'Failed to fetch Grafana organizations',
    });
  }
});

router.get('/datasources', async (req, res) => {
  try {
    const username = process.env.GRAFANA_USER;
    const token = process.env.GRAFANA_TOKEN;

    if (!username || !token) {
      return res.status(500).json({
        error: 'Grafana credentials not configured',
      });
    }

    const credentials = Buffer.from(`${username}:${token}`).toString('base64');
    const orgId = req.query.orgId as string | undefined;

    const headers: Record<string, string> = {
      Authorization: `Basic ${credentials}`,
    };

    if (orgId) {
      headers['X-Grafana-Org-Id'] = orgId;
    }

    const data = await fetchGrafana<any>(
      'https://grafana.k8s.metabit-trading.com/api/datasources',
      headers,
    );

    return res.status(200).json(data);
  } catch (error) {
    logger.error('Error fetching Grafana datasources:', error);
    return res.status(500).json({
      error: 'Failed to fetch Grafana datasources',
    });
  }
});

export default router;
