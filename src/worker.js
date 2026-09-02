const STATS_KEY = 'global';
const MAX_BYTES = 500 * 1024 * 1024;

function defaultStats() {
  return {
    processed: 0,
    resized: 0,
    bytesIn: 0,
    bytesOut: 0,
    images: 0,
    pdfs: 0,
    docxs: 0,
    updatedAt: null,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

async function readStats(env) {
  const raw = await env.STATS.get(STATS_KEY);
  if (!raw) return defaultStats();
  try {
    return { ...defaultStats(), ...JSON.parse(raw) };
  } catch {
    return defaultStats();
  }
}

async function writeStats(env, stats) {
  stats.updatedAt = new Date().toISOString();
  await env.STATS.put(STATS_KEY, JSON.stringify(stats));
  return stats;
}

function clampInt(n, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

async function handleStatsApi(request, env) {
  if (request.method === 'OPTIONS') return corsPreflight();

  if (request.method === 'GET') {
    return json(await readStats(env));
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const origSize = clampInt(body.origSize, MAX_BYTES);
    const outSize  = clampInt(body.outSize, MAX_BYTES);
    const optimized = !!body.optimized;
    const kind     = body.kind;

    if (!origSize && !outSize) {
      return json({ error: 'Missing file sizes' }, 400);
    }
    if (!['image', 'pdf', 'docx'].includes(kind)) {
      return json({ error: 'Invalid kind' }, 400);
    }

    const stats = await readStats(env);
    stats.processed += 1;
    if (optimized) stats.resized += 1;
    stats.bytesIn  += origSize;
    stats.bytesOut += outSize;
    if (kind === 'image') stats.images += 1;
    if (kind === 'pdf')   stats.pdfs   += 1;
    if (kind === 'docx')  stats.docxs  += 1;

    return json(await writeStats(env, stats));
  }

  return json({ error: 'Method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/stats') {
      return handleStatsApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
