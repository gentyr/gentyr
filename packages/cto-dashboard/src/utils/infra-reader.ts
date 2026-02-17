/**
 * Infrastructure Data Reader
 *
 * Queries 5 providers in parallel: Render, Vercel, Supabase, Elastic, Cloudflare.
 * Each provider independently degradable — missing credentials or API failures
 * result in { available: false } for that provider.
 */

import { resolveCredential, fetchWithTimeout } from './credentials.js';

// ============================================================================
// Types
// ============================================================================

export interface InfraData {
  hasData: boolean;
  render: { serviceCount: number; suspendedCount: number; available: boolean };
  vercel: { projectCount: number; errorDeploys: number; available: boolean };
  supabase: { healthy: boolean; available: boolean };
  elastic: {
    available: boolean;
    totalLogs1h: number;
    errorCount1h: number;
    warnCount1h: number;
    topServices: Array<{ name: string; count: number }>;
  };
  cloudflare: { status: string; nameServers: string[]; available: boolean };
}

// ============================================================================
// Provider Queries
// ============================================================================

async function queryRender(): Promise<InfraData['render']> {
  const apiKey = resolveCredential('RENDER_API_KEY');
  if (!apiKey) return { serviceCount: 0, suspendedCount: 0, available: false };

  const resp = await fetchWithTimeout(
    'https://api.render.com/v1/services?limit=50',
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
  );
  if (!resp.ok) return { serviceCount: 0, suspendedCount: 0, available: false };

  const services = await resp.json() as Array<{ service: { suspended: string } }>;
  const suspendedCount = services.filter(s => s.service.suspended === 'suspended').length;

  return { serviceCount: services.length, suspendedCount, available: true };
}

async function queryVercel(): Promise<InfraData['vercel']> {
  const token = resolveCredential('VERCEL_TOKEN');
  if (!token) return { projectCount: 0, errorDeploys: 0, available: false };

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  const [projectsResult, errorsResult] = await Promise.allSettled([
    fetchWithTimeout('https://api.vercel.com/v9/projects?limit=50', { headers }),
    fetchWithTimeout('https://api.vercel.com/v6/deployments?state=ERROR&limit=5', { headers }),
  ]);

  let projectCount = 0;
  if (projectsResult.status === 'fulfilled' && projectsResult.value.ok) {
    const data = await projectsResult.value.json() as { projects?: unknown[] };
    projectCount = data.projects?.length || 0;
  }

  let errorDeploys = 0;
  if (errorsResult.status === 'fulfilled' && errorsResult.value.ok) {
    const data = await errorsResult.value.json() as { deployments?: Array<{ created: number }> };
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    errorDeploys = (data.deployments || []).filter(d => d.created > cutoff24h).length;
  }

  return { projectCount, errorDeploys, available: true };
}

async function querySupabase(): Promise<InfraData['supabase']> {
  const url = resolveCredential('SUPABASE_URL');
  const serviceKey = resolveCredential('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return { healthy: false, available: false };

  const resp = await fetchWithTimeout(
    `${url}/rest/v1/`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    },
  );

  return { healthy: resp.ok, available: true };
}

interface ElasticAggResponse {
  hits?: { total?: { value?: number } };
  aggregations?: {
    by_level?: { buckets?: Array<{ key: string; doc_count: number }> };
    by_service?: { buckets?: Array<{ key: string; doc_count: number }> };
  };
}

async function queryElastic(): Promise<InfraData['elastic']> {
  const endpoint = resolveCredential('ELASTIC_ENDPOINT');
  const apiKey = resolveCredential('ELASTIC_API_KEY');
  if (!endpoint || !apiKey) return { available: false, totalLogs1h: 0, errorCount1h: 0, warnCount1h: 0, topServices: [] };

  const body = JSON.stringify({
    size: 0,
    query: { range: { '@timestamp': { gte: 'now-1h' } } },
    aggs: {
      by_level: { terms: { field: 'level' } },
      by_service: { terms: { field: 'service', size: 5 } },
    },
  });

  const resp = await fetchWithTimeout(
    `${endpoint}/logs-*/_search`,
    {
      method: 'POST',
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    },
  );

  if (!resp.ok) return { available: false, totalLogs1h: 0, errorCount1h: 0, warnCount1h: 0, topServices: [] };

  const data = await resp.json() as ElasticAggResponse;
  const totalLogs1h = data.hits?.total?.value || 0;
  const levelBuckets = data.aggregations?.by_level?.buckets || [];
  const errorCount1h = levelBuckets.find(b => b.key === 'error')?.doc_count || 0;
  const warnCount1h = levelBuckets.find(b => b.key === 'warn' || b.key === 'warning')?.doc_count || 0;
  const topServices = (data.aggregations?.by_service?.buckets || []).map(b => ({
    name: b.key,
    count: b.doc_count,
  }));

  return { available: true, totalLogs1h, errorCount1h, warnCount1h, topServices };
}

async function queryCloudflare(): Promise<InfraData['cloudflare']> {
  const token = resolveCredential('CF_API_TOKEN');
  const zoneId = resolveCredential('CLOUDFLARE_ZONE_ID');
  if (!token || !zoneId) return { status: 'unavailable', nameServers: [], available: false };

  const resp = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );

  if (!resp.ok) return { status: 'unavailable', nameServers: [], available: false };

  const data = await resp.json() as {
    result?: { status?: string; name_servers?: string[] };
  };

  return {
    status: data.result?.status || 'unknown',
    nameServers: data.result?.name_servers || [],
    available: true,
  };
}

// ============================================================================
// Main
// ============================================================================

export async function getInfraData(): Promise<InfraData> {
  const [renderResult, vercelResult, supabaseResult, elasticResult, cloudflareResult] =
    await Promise.allSettled([
      queryRender(),
      queryVercel(),
      querySupabase(),
      queryElastic(),
      queryCloudflare(),
    ]);

  const render = renderResult.status === 'fulfilled'
    ? renderResult.value
    : { serviceCount: 0, suspendedCount: 0, available: false };

  const vercel = vercelResult.status === 'fulfilled'
    ? vercelResult.value
    : { projectCount: 0, errorDeploys: 0, available: false };

  const supabase = supabaseResult.status === 'fulfilled'
    ? supabaseResult.value
    : { healthy: false, available: false };

  const elastic = elasticResult.status === 'fulfilled'
    ? elasticResult.value
    : { available: false, totalLogs1h: 0, errorCount1h: 0, warnCount1h: 0, topServices: [] };

  const cloudflare = cloudflareResult.status === 'fulfilled'
    ? cloudflareResult.value
    : { status: 'unavailable', nameServers: [], available: false };

  const hasData = render.available || vercel.available || supabase.available
    || elastic.available || cloudflare.available;

  return { hasData, render, vercel, supabase, elastic, cloudflare };
}
