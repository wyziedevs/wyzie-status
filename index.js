'use strict';

const http = require('http');
const https = require('https');

const PORT = 4389;
const CHECK_INTERVAL_MS = 5000;    // main health checks
const SOURCE_INTERVAL_MS = 60000;  // /api/status poll (upstream caches 3 min)
const DOWNLOAD_INTERVAL_MS = 120000; // /c/ download checks every 2 min
const MAX_HISTORY = 2016;          // ~2.8h at 5s per main check
const MAX_SOURCE_HISTORY = 1440;   // 24h at 60s per source
const MAX_DOWNLOAD_HISTORY = 720;  // 24h at 120s per source

// ---------------------------------------------------------------------------
// Random media pool
// ---------------------------------------------------------------------------

const MEDIA_POOL = [
  // Movies
  { id: 550,    label: 'Fight Club' },
  { id: 155,    label: 'The Dark Knight' },
  { id: 603,    label: 'The Matrix' },
  { id: 680,    label: 'Pulp Fiction' },
  { id: 238,    label: 'The Godfather' },
  { id: 278,    label: 'The Shawshank Redemption' },
  { id: 13,     label: 'Forrest Gump' },
  { id: 120,    label: 'The Fellowship of the Ring' },
  { id: 157336, label: 'Interstellar' },
  { id: 286217, label: 'The Martian' },
  { id: 27205,  label: 'Inception' },
  { id: 24428,  label: 'The Avengers' },
  { id: 299536, label: 'Avengers: Infinity War' },
  { id: 1726,   label: 'Iron Man' },
  { id: 11,     label: 'Star Wars: A New Hope' },
  { id: 1891,   label: 'The Empire Strikes Back' },
  { id: 78,     label: 'Blade Runner' },
  { id: 101,    label: 'Leon: The Professional' },
  { id: 769,    label: 'GoodFellas' },
  { id: 11216,  label: 'Cinema Paradiso' },
  // TV
  { id: 1399,   label: 'Game of Thrones' },
  { id: 1396,   label: 'Breaking Bad' },
  { id: 94997,  label: 'House of the Dragon' },
  { id: 63174,  label: 'Lucifer' },
  { id: 1434,   label: 'Family Guy' },
  { id: 2190,   label: 'South Park' },
  { id: 44217,  label: 'Vikings' },
  { id: 100088, label: 'The Last of Us' },
  { id: 60735,  label: 'The Flash' },
  { id: 57243,  label: 'Doctor Who' },
  { id: 66732,  label: 'Stranger Things' },
  { id: 1402,   label: 'The Walking Dead' },
  { id: 1418,   label: 'The Big Bang Theory' },
  { id: 1668,   label: 'Friends' },
  { id: 4607,   label: 'Lost' },
  { id: 18347,  label: 'Black Mirror' },
  { id: 71446,  label: 'Money Heist' },
  { id: 87108,  label: 'Chernobyl' },
  { id: 76479,  label: 'The Boys' },
  { id: 85552,  label: 'Euphoria' },
];

function pickMedia() {
  return MEDIA_POOL[Math.floor(Math.random() * MEDIA_POOL.length)];
}

let currentMedia = pickMedia();

// ---------------------------------------------------------------------------
// Main health checks
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    name: 'Subs API — root',
    url: 'https://sub.wyzie.io/',
    validate: (status) => status === 200,
  },
  {
    name: 'Subs API — search',
    url: () => {
      currentMedia = pickMedia();
      return `https://sub.wyzie.io/search?id=${currentMedia.id}`;
    },
    validate: (status) => status > 0 && status < 500,
    label: () => `Subs API — search (${currentMedia.label} tmdb:${currentMedia.id})`,
  },
  {
    name: 'Wyzie API — health',
    url: 'https://api.wyzie.io/health',
    validate: (status, body) => {
      if (status !== 200) return false;
      try { return JSON.parse(body).status === 'ok'; } catch { return false; }
    },
  },
  {
    name: 'wyzie-lib — npm',
    url: 'https://registry.npmjs.org/wyzie-lib/latest',
    validate: (status, body) => {
      if (status !== 200) return false;
      try { return !!JSON.parse(body).version; } catch { return false; }
    },
    extractMeta: (body) => {
      try {
        const d = JSON.parse(body);
        return { version: d.version, description: d.description };
      } catch { return {}; }
    },
  },
];

// ---------------------------------------------------------------------------
// State — main checks
// ---------------------------------------------------------------------------

const state = CHECKS.map(() => ({
  history: [],  // { ts, ok, ms, httpStatus, error, resolvedUrl, resolvedLabel }
  meta: {},
  lastLabel: '',
}));

// ---------------------------------------------------------------------------
// State — source checks
// ---------------------------------------------------------------------------

// sourceState['subdl'] = { history: [{ts, status, movieStatus, tvStatus, latencyMs}], name: "SubDL" }
const sourceState = {};

// ---------------------------------------------------------------------------
// State — download (/c/) checks
// ---------------------------------------------------------------------------

// Test queries per source for download checks
const DOWNLOAD_TEST_QUERIES = {
  opensubtitles: { id: 'tt1490017' },
  subdl:         { id: 'tt1490017' },
  subf2m:        { id: 'tt1490017' },
  podnapisi:     { id: 'tt1490017' },
  animetosho:    { id: 'tt2560140', season: 1, episode: 1 },
  jimaku:        { id: 'tt2560140', season: 1, episode: 1 },
  kitsunekko:    { id: 'tt0245429' },
  gestdown:      { id: 'tt2861424', season: 1, episode: 1 },
  yify:          { id: 'tt0111161' },
  ajatttools:    { id: 'tt2560140', season: 1, episode: 1 },
};

// downloadState['subdl'] = { history: [{ts, searchOk, downloadOk, searchMs, downloadMs, downloadUrl, httpStatus, contentLength, error}] }
const downloadState = {};

let lastDownloadCheck = { ts: 0, ok: false };
let totalDownloadChecksRun = 0;

let lastSourceFetch = { ts: 0, ok: false, ms: 0, httpStatus: 0, error: null };
let startedAt = Date.now();
let totalChecksRun = 0;
let totalSourceChecksRun = 0;

// ---------------------------------------------------------------------------
// HTTP fetch helper
// ---------------------------------------------------------------------------

function fetchUrl(rawUrl, timeoutMs = 12000, maxBody = 16384) {
  return new Promise((resolve) => {
    const start = Date.now();
    let url;
    try { url = new URL(rawUrl); } catch {
      return resolve({ ms: 0, httpStatus: 0, error: 'Invalid URL', body: '' });
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(rawUrl, { headers: { 'User-Agent': 'wyzie-status/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        ms: Date.now() - start,
        httpStatus: res.statusCode,
        error: null,
        body: Buffer.concat(chunks).toString('utf8', 0, maxBody),
      }));
      res.on('error', err =>
        resolve({ ms: Date.now() - start, httpStatus: 0, error: err.message, body: '' }));
    });
    req.on('error', err =>
      resolve({ ms: Date.now() - start, httpStatus: 0, error: err.message, body: '' }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ms: timeoutMs, httpStatus: 0, error: 'Timeout', body: '' });
    });
  });
}

// ---------------------------------------------------------------------------
// Main health check runner (every 5s)
// ---------------------------------------------------------------------------

async function runChecks() {
  totalChecksRun++;
  const label = `[${new Date().toISOString()}] check #${totalChecksRun}`;

  for (let i = 0; i < CHECKS.length; i++) {
    const check = CHECKS[i];
    const resolvedUrl = typeof check.url === 'function' ? check.url() : check.url;
    const resolvedLabel = typeof check.label === 'function' ? check.label() : check.name;
    state[i].lastLabel = resolvedLabel;

    const result = await fetchUrl(resolvedUrl);
    const ok = check.validate(result.httpStatus, result.body);

    if (check.extractMeta && result.body) {
      const meta = check.extractMeta(result.body);
      if (Object.keys(meta).length) state[i].meta = meta;
    }

    state[i].history.push({ ts: Date.now(), ok, ms: result.ms, httpStatus: result.httpStatus, error: result.error, resolvedUrl, resolvedLabel });
    if (state[i].history.length > MAX_HISTORY) state[i].history.shift();

    console.log(`${label} | ${ok ? 'UP  ' : 'DOWN'} | ${result.ms}ms | HTTP ${result.httpStatus || 'ERR'} | ${resolvedLabel}${result.error ? ' | ' + result.error : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Source status check runner (every 60s via /api/status)
// ---------------------------------------------------------------------------

async function runSourceChecks() {
  totalSourceChecksRun++;
  const ts = Date.now();
  const result = await fetchUrl('https://sub.wyzie.io/api/status', 20000);

  lastSourceFetch = { ts, ok: result.httpStatus === 200, ms: result.ms, httpStatus: result.httpStatus, error: result.error };

  if (result.httpStatus !== 200 || !result.body) {
    console.log(`[${new Date().toISOString()}] SOURCE CHECK #${totalSourceChecksRun} | FAIL | HTTP ${result.httpStatus || 'ERR'} | ${result.error || 'empty body'}`);
    return;
  }

  let data;
  try { data = JSON.parse(result.body); }
  catch (e) {
    console.log(`[${new Date().toISOString()}] SOURCE CHECK #${totalSourceChecksRun} | FAIL | JSON parse error: ${e.message}`);
    return;
  }

  const sources = Object.keys(data);
  for (const key of sources) {
    const val = data[key];
    if (!sourceState[key]) sourceState[key] = { history: [], name: val.name || key };
    sourceState[key].name = val.name || key;
    const latencyMs = parseInt(val.latency) || 0;
    sourceState[key].history.push({ ts, status: val.status, movieStatus: val.movieStatus, tvStatus: val.tvStatus, latencyMs });
    if (sourceState[key].history.length > MAX_SOURCE_HISTORY) sourceState[key].history.shift();
  }

  console.log(`[${new Date().toISOString()}] SOURCE CHECK #${totalSourceChecksRun} | OK | ${result.ms}ms | ${sources.length} sources`);
  for (const key of sources) {
    const d = data[key];
    console.log(`  ${d.name.padEnd(16)} ${d.status.padEnd(12)} movie:${d.movieStatus.padEnd(12)} tv:${d.tvStatus.padEnd(12)} latency:${d.latency}`);
  }
}

// ---------------------------------------------------------------------------
// Download (/c/) check runner (every 120s)
// ---------------------------------------------------------------------------

async function runDownloadChecks() {
  totalDownloadChecksRun++;
  const ts = Date.now();
  const label = `[${new Date().toISOString()}] DOWNLOAD CHECK #${totalDownloadChecksRun}`;
  const sourceKeys = Object.keys(DOWNLOAD_TEST_QUERIES);

  console.log(`${label} | checking ${sourceKeys.length} sources`);

  for (const key of sourceKeys) {
    const testQuery = DOWNLOAD_TEST_QUERIES[key];
    if (!downloadState[key]) downloadState[key] = { history: [] };

    const entry = { ts, searchOk: false, downloadOk: false, searchMs: 0, downloadMs: 0, downloadUrl: null, httpStatus: 0, contentLength: 0, error: null };

    // Step 1: search for subtitles for this source
    let params = `id=${testQuery.id}&source=${key}`;
    if (testQuery.season) params += `&season=${testQuery.season}&episode=${testQuery.episode}`;
    const searchUrl = `https://sub.wyzie.io/search?${params}`;

    const searchResult = await fetchUrl(searchUrl, 20000, 256 * 1024);
    entry.searchMs = searchResult.ms;

    if (searchResult.httpStatus !== 200 || !searchResult.body) {
      entry.error = `search failed: HTTP ${searchResult.httpStatus || 'ERR'}${searchResult.error ? ' - ' + searchResult.error : ''}`;
      downloadState[key].history.push(entry);
      if (downloadState[key].history.length > MAX_DOWNLOAD_HISTORY) downloadState[key].history.shift();
      console.log(`  ${key.padEnd(16)} FAIL | search error: ${entry.error}`);
      continue;
    }

    let results;
    try { results = JSON.parse(searchResult.body); }
    catch (e) {
      entry.error = 'search JSON parse error: ' + e.message;
      downloadState[key].history.push(entry);
      if (downloadState[key].history.length > MAX_DOWNLOAD_HISTORY) downloadState[key].history.shift();
      console.log(`  ${key.padEnd(16)} FAIL | ${entry.error}`);
      continue;
    }

    if (!Array.isArray(results) || results.length === 0) {
      entry.error = 'search returned no results';
      downloadState[key].history.push(entry);
      if (downloadState[key].history.length > MAX_DOWNLOAD_HISTORY) downloadState[key].history.shift();
      console.log(`  ${key.padEnd(16)} FAIL | no search results`);
      continue;
    }

    entry.searchOk = true;

    // Step 2: try downloading the first result's URL via /c/
    const downloadUrl = results[0].url;
    if (!downloadUrl) {
      entry.error = 'result has no url';
      downloadState[key].history.push(entry);
      if (downloadState[key].history.length > MAX_DOWNLOAD_HISTORY) downloadState[key].history.shift();
      console.log(`  ${key.padEnd(16)} FAIL | result missing url`);
      continue;
    }

    entry.downloadUrl = downloadUrl;
    const dlResult = await fetchUrl(downloadUrl, 20000);
    entry.downloadMs = dlResult.ms;
    entry.httpStatus = dlResult.httpStatus;
    entry.contentLength = dlResult.body ? dlResult.body.length : 0;

    if (dlResult.httpStatus >= 200 && dlResult.httpStatus < 400 && entry.contentLength > 0) {
      entry.downloadOk = true;
      console.log(`  ${key.padEnd(16)} OK   | search:${entry.searchMs}ms download:${entry.downloadMs}ms HTTP ${entry.httpStatus} ${entry.contentLength}B`);
    } else {
      entry.error = `download failed: HTTP ${dlResult.httpStatus || 'ERR'} ${entry.contentLength}B${dlResult.error ? ' - ' + dlResult.error : ''}`;
      console.log(`  ${key.padEnd(16)} FAIL | ${entry.error}`);
    }

    downloadState[key].history.push(entry);
    if (downloadState[key].history.length > MAX_DOWNLOAD_HISTORY) downloadState[key].history.shift();
  }

  lastDownloadCheck = { ts, ok: true };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function calcStats(history) {
  if (!history.length) return { uptime: null, avg: null, min: null, max: null, p95: null, total: 0, up: 0 };
  const up = history.filter(e => e.ok).length;
  const times = history.filter(e => e.ok).map(e => e.ms);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const min = times.length ? Math.min(...times) : null;
  const max = times.length ? Math.max(...times) : null;
  let p95 = null;
  if (times.length > 1) {
    const sorted = [...times].sort((a, b) => a - b);
    p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  }
  return { uptime: ((up / history.length) * 100).toFixed(2), avg, min, max, p95, total: history.length, up };
}

function calcSourceStats(history) {
  if (!history.length) return { uptime: null, avgLatency: null, total: 0, up: 0 };
  const up = history.filter(e => e.status === 'operational').length;
  const latencies = history.filter(e => e.latencyMs > 0).map(e => e.latencyMs);
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  return { uptime: ((up / history.length) * 100).toFixed(2), avgLatency: avg, total: history.length, up };
}

function calcDownloadStats(history) {
  if (!history.length) return { uptime: null, avgSearchMs: null, avgDownloadMs: null, total: 0, up: 0 };
  const up = history.filter(e => e.downloadOk).length;
  const searchTimes = history.filter(e => e.searchOk).map(e => e.searchMs);
  const dlTimes = history.filter(e => e.downloadOk).map(e => e.downloadMs);
  const avgSearch = searchTimes.length ? Math.round(searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length) : null;
  const avgDl = dlTimes.length ? Math.round(dlTimes.reduce((a, b) => a + b, 0) / dlTimes.length) : null;
  return { uptime: ((up / history.length) * 100).toFixed(2), avgSearchMs: avgSearch, avgDownloadMs: avgDl, total: history.length, up };
}

// ---------------------------------------------------------------------------
// SVG chart builders
// ---------------------------------------------------------------------------

function escSvg(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Latency line chart: entries = [{latencyMs}]
function svgLatencyLine(entries, w, h) {
  w = w || 300;
  h = h || 50;
  const vals = entries.map(e => e.latencyMs).filter(v => v > 0);
  if (vals.length < 2) {
    return '<svg width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg"><text x="4" y="20" font-size="10" fill="#888">no data yet</text></svg>';
  }
  const maxV = Math.max.apply(null, vals);
  const minV = Math.min.apply(null, vals);
  const range = maxV - minV || 1;
  const pts = vals.map(function(v, i) {
    const x = (i / (vals.length - 1)) * (w - 4) + 2;
    const y = (h - 8) - ((v - minV) / range) * (h - 16) + 4;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const last = vals[vals.length - 1];
  const lastX = ((w - 4) + 2).toFixed(1);
  const lastY = ((h - 8) - ((last - minV) / range) * (h - 16) + 4).toFixed(1);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" style="border:1px solid #ccc;display:block">' +
    '<polyline points="' + pts + '" fill="none" stroke="#333" stroke-width="1.5"/>' +
    '<circle cx="' + lastX + '" cy="' + lastY + '" r="2.5" fill="#000"/>' +
    '<text x="2" y="11" font-size="9" fill="#888">' + maxV + 'ms</text>' +
    '<text x="2" y="' + (h - 1) + '" font-size="9" fill="#888">' + minV + 'ms</text>' +
    '</svg>';
}

// Horizontal uptime bar chart for all sources
// sources = [{name, uptime, status}]
function svgUptimeBars(sources) {
  const labelW = 110;
  const barAreaW = 200;
  const numW = 55;
  const rowH = 22;
  const pad = 4;
  const totalW = labelW + barAreaW + numW;
  const totalH = sources.length * rowH + pad * 2;
  let rows = '';
  for (let i = 0; i < sources.length; i++) {
    const name = sources[i].name;
    const uptime = sources[i].uptime;
    const status = sources[i].status;
    const pct = parseFloat(uptime) || 0;
    let fill = '#2a2';
    if (status === 'down') fill = '#c22';
    else if (status === 'degraded') fill = '#c80';
    else if (pct < 90) fill = '#c22';
    else if (pct < 99) fill = '#6a6';
    const bw = Math.max(1, Math.round((pct / 100) * barAreaW));
    const y = pad + i * rowH;
    rows += '<text x="' + (labelW - 4) + '" y="' + (y + 14) + '" text-anchor="end" font-size="11" font-family="monospace">' + escSvg(name) + '</text>';
    rows += '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + bw + '" height="' + (rowH - 8) + '" fill="' + fill + '"/>';
    rows += '<text x="' + (labelW + barAreaW + 4) + '" y="' + (y + 14) + '" font-size="11" font-family="monospace" fill="#333">' + (uptime !== null ? uptime + '%' : 'n/a') + '</text>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW + '" height="' + totalH + '">' + rows + '</svg>';
}

// ---------------------------------------------------------------------------
// HTML / text helpers
// ---------------------------------------------------------------------------

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtMs(ms) { return ms === null ? 'n/a' : ms + 'ms'; }
function fmtTs(ts) { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }

function uptimeBand(pct) {
  if (pct === null) return '';
  const n = parseFloat(pct);
  if (n >= 99) return 'color:green';
  if (n >= 95) return 'color:darkorange';
  return 'color:red';
}

function statusColor(s) {
  if (s === 'operational') return 'color:green';
  if (s === 'degraded') return 'color:darkorange';
  if (s === 'down') return 'color:red';
  return 'color:gray';
}

// ---------------------------------------------------------------------------
// JSON endpoint
// ---------------------------------------------------------------------------

function buildJsonResponse() {
  return {
    startedAt,
    now: Date.now(),
    totalChecksRun,
    totalSourceChecksRun,
    lastSourceFetch,
    checks: CHECKS.map(function(c, i) {
      return {
        name: c.name,
        lastLabel: state[i].lastLabel || c.name,
        url: (state[i].history[state[i].history.length - 1] || {}).resolvedUrl || (typeof c.url === 'string' ? c.url : ''),
        meta: state[i].meta,
        stats: calcStats(state[i].history),
        last: state[i].history[state[i].history.length - 1] || null,
        history: state[i].history.slice(-120),
      };
    }),
    sources: Object.keys(sourceState).reduce(function(acc, key) {
      const s = sourceState[key];
      acc[key] = {
        name: s.name,
        stats: calcSourceStats(s.history),
        last: s.history[s.history.length - 1] || null,
        history: s.history.slice(-120),
      };
      return acc;
    }, {}),
    downloads: Object.keys(downloadState).reduce(function(acc, key) {
      const s = downloadState[key];
      acc[key] = {
        stats: calcDownloadStats(s.history),
        last: s.history[s.history.length - 1] || null,
        history: s.history.slice(-60),
      };
      return acc;
    }, {}),
    totalDownloadChecksRun,
  };
}

// ---------------------------------------------------------------------------
// HTML dashboard
// ---------------------------------------------------------------------------

function buildHtml() {
  const now = Date.now();
  const upSec = Math.floor((now - startedAt) / 1000);
  const upH = Math.floor(upSec / 3600);
  const upM = Math.floor((upSec % 3600) / 60);
  const upS = upSec % 60;

  // ---- Main service checks ---------------------------------------------------
  let mainChecks = '';
  for (let i = 0; i < CHECKS.length; i++) {
    const s = state[i];
    const stats = calcStats(s.history);
    const last = s.history[s.history.length - 1];
    const isUp = last ? last.ok : null;
    const statusLabel = isUp === null ? 'PENDING' : isUp ? 'UP' : 'DOWN';
    const statusStyle = isUp === null ? '' : isUp ? 'color:green' : 'color:red';
    const recent = s.history.slice(-60);
    const spark = recent.map(function(e) { return e.ok ? '\u2588' : '\u2591'; }).join('');
    const displayUrl = (last && last.resolvedUrl) || (typeof CHECKS[i].url === 'string' ? CHECKS[i].url : '(pending)');
    const displayName = s.lastLabel || CHECKS[i].name;
    const versionLine = s.meta.version ? ' \u2014 npm <strong>v' + escHtml(s.meta.version) + '</strong>' : '';
    const lastLine = last
      ? 'HTTP ' + (last.httpStatus || 'ERR') + ' \u2014 ' + last.ms + 'ms \u2014 ' + fmtTs(last.ts) + (last.error ? ' \u2014 <em>' + escHtml(last.error) + '</em>' : '')
      : 'No data yet.';

    mainChecks +=
      '<tr>' +
        '<td><strong style="' + statusStyle + '">' + statusLabel + '</strong></td>' +
        '<td>' + escHtml(displayName) + versionLine + '</td>' +
        '<td><a href="' + escHtml(displayUrl) + '">' + escHtml(displayUrl) + '</a></td>' +
        '<td style="' + uptimeBand(stats.uptime) + '">' + (stats.uptime !== null ? stats.uptime + '%' : 'n/a') + '</td>' +
        '<td>' + fmtMs(stats.avg) + '</td>' +
        '<td>' + fmtMs(stats.p95) + '</td>' +
        '<td>' + stats.up + '/' + stats.total + '</td>' +
      '</tr>' +
      '<tr><td colspan="7"><code title="Last 60 checks, right=newest">' + (spark || '...') + '</code>&nbsp;<small>' + lastLine + '</small></td></tr>';
  }

  // ---- Source status section -------------------------------------------------
  const sourceKeys = Object.keys(sourceState);
  let sourcesHtml = '';

  if (!sourceKeys.length) {
    sourcesHtml = '<p><em>Waiting for first source check (runs every 60s)...</em></p>';
  } else {
    // Uptime bar chart
    const barData = sourceKeys.map(function(k) {
      const stats = calcSourceStats(sourceState[k].history);
      const last = sourceState[k].history[sourceState[k].history.length - 1];
      return { name: sourceState[k].name, uptime: stats.uptime, status: (last && last.status) || 'down' };
    });

    sourcesHtml += '<h2>Source uptime overview</h2>\n<p>' + svgUptimeBars(barData) + '</p>\n<hr>\n';
    sourcesHtml += '<h2>Per-source detail</h2>\n';
    sourcesHtml += '<table>\n<thead><tr><th>Source</th><th>Status</th><th>Movie</th><th>TV</th><th>Uptime</th><th>Avg latency</th><th>Checks</th><th>Latency trend (last 60)</th></tr></thead>\n<tbody>\n';

    for (let ki = 0; ki < sourceKeys.length; ki++) {
      const key = sourceKeys[ki];
      const s = sourceState[key];
      const stats = calcSourceStats(s.history);
      const last = s.history[s.history.length - 1];
      const recent = s.history.slice(-60);
      const spark = recent.map(function(e) {
        if (e.status === 'operational') return '\u2588';
        if (e.status === 'degraded') return '\u2592';
        if (e.status === 'down') return '\u2591';
        return '\u00b7';
      }).join('');

      sourcesHtml +=
        '<tr>' +
          '<td><strong>' + escHtml(s.name) + '</strong></td>' +
          '<td style="' + statusColor(last && last.status) + '">' + escHtml((last && last.status) || 'n/a') + '</td>' +
          '<td style="' + statusColor(last && last.movieStatus) + '">' + escHtml((last && last.movieStatus) || 'n/a') + '</td>' +
          '<td style="' + statusColor(last && last.tvStatus) + '">' + escHtml((last && last.tvStatus) || 'n/a') + '</td>' +
          '<td style="' + uptimeBand(stats.uptime) + '">' + (stats.uptime !== null ? stats.uptime + '%' : 'n/a') + '</td>' +
          '<td>' + fmtMs(stats.avgLatency) + '</td>' +
          '<td>' + stats.up + '/' + stats.total + '</td>' +
          '<td rowspan="2">' + svgLatencyLine(recent) + '</td>' +
        '</tr>' +
        '<tr><td colspan="7"><code title="\u2588 operational  \u2592 degraded  \u2591 down">' + (spark || '...') + '</code>' +
          '&nbsp;<small>last checked ' + (last ? fmtTs(last.ts) : 'never') + '</small></td></tr>';
    }
    sourcesHtml += '</tbody>\n</table>\n';

    const fetchInfo = lastSourceFetch.ts
      ? 'Last /api/status fetch: ' + fmtTs(lastSourceFetch.ts) + ' \u2014 ' + lastSourceFetch.ms + 'ms HTTP ' + lastSourceFetch.httpStatus + (lastSourceFetch.error ? ' \u2014 <em>' + escHtml(lastSourceFetch.error) + '</em>' : '')
      : 'No source fetch yet.';
    sourcesHtml += '<p><small>' + fetchInfo + '</small></p>';
  }

  // ---- Download (/c/) checks section ----------------------------------------
  const dlKeys = Object.keys(downloadState);
  let downloadHtml = '';

  if (!dlKeys.length) {
    downloadHtml = '<p><em>Waiting for first download check (runs every 120s)...</em></p>';
  } else {
    downloadHtml += '<table>\n<thead><tr><th>Source</th><th>Search</th><th>Download</th><th>Uptime</th><th>Avg Search</th><th>Avg Download</th><th>Checks</th></tr></thead>\n<tbody>\n';

    for (let di = 0; di < dlKeys.length; di++) {
      const key = dlKeys[di];
      const s = downloadState[key];
      const stats = calcDownloadStats(s.history);
      const last = s.history[s.history.length - 1];
      const recent = s.history.slice(-30);
      const spark = recent.map(function(e) {
        if (e.downloadOk) return '\u2588';
        if (e.searchOk) return '\u2592';
        return '\u2591';
      }).join('');

      const searchStatus = last ? (last.searchOk ? 'OK' : 'FAIL') : 'n/a';
      const searchStyle = last ? (last.searchOk ? 'color:green' : 'color:red') : '';
      const dlStatus = last ? (last.downloadOk ? 'OK' : 'FAIL') : 'n/a';
      const dlStyle = last ? (last.downloadOk ? 'color:green' : 'color:red') : '';
      const lastErr = last && last.error ? ' \u2014 <em>' + escHtml(last.error) + '</em>' : '';
      const lastInfo = last
        ? 'search:' + last.searchMs + 'ms download:' + last.downloadMs + 'ms HTTP ' + (last.httpStatus || 'n/a') + ' ' + (last.contentLength || 0) + 'B' + lastErr + ' \u2014 ' + fmtTs(last.ts)
        : 'No data yet.';

      downloadHtml +=
        '<tr>' +
          '<td><strong>' + escHtml(key) + '</strong></td>' +
          '<td style="' + searchStyle + '">' + searchStatus + '</td>' +
          '<td style="' + dlStyle + '">' + dlStatus + '</td>' +
          '<td style="' + uptimeBand(stats.uptime) + '">' + (stats.uptime !== null ? stats.uptime + '%' : 'n/a') + '</td>' +
          '<td>' + fmtMs(stats.avgSearchMs) + '</td>' +
          '<td>' + fmtMs(stats.avgDownloadMs) + '</td>' +
          '<td>' + stats.up + '/' + stats.total + '</td>' +
        '</tr>' +
        '<tr><td colspan="7"><code title="\u2588 all ok  \u2592 search ok  \u2591 fail">' + (spark || '...') + '</code>&nbsp;<small>' + lastInfo + '</small></td></tr>';
    }
    downloadHtml += '</tbody>\n</table>\n';
    downloadHtml += '<p><small>Download checks run: ' + totalDownloadChecksRun + (lastDownloadCheck.ts ? ' \u2014 last: ' + fmtTs(lastDownloadCheck.ts) : '') + '</small></p>';
  }

  return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="utf-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'  <meta http-equiv="refresh" content="10">\n' +
'  <title>wyzie-status</title>\n' +
'  <style>\n' +
'    body { max-width:960px; margin:2em auto; padding:0 1em; font-family:serif; line-height:1.5; }\n' +
'    h1, h2 { font-family:sans-serif; }\n' +
'    h2 { margin-top:1.5em; }\n' +
'    table { border-collapse:collapse; width:100%; margin:0.5em 0; }\n' +
'    th, td { border:1px solid #bbb; padding:0.25em 0.5em; text-align:left; vertical-align:middle; }\n' +
'    thead th { background:#eee; }\n' +
'    code { font-size:0.85em; letter-spacing:1px; }\n' +
'    a { color:#00e; }\n' +
'    small { color:#555; }\n' +
'    hr { margin:1.5em 0; }\n' +
'    svg text { user-select:none; }\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n' +
'<h1>wyzie-status</h1>\n' +
'<p>\n' +
'  Health checks every 5s &mdash; Source checks every 60s &mdash; Download checks every 120s &mdash; Page auto-refreshes every 10s.<br>\n' +
'  Monitor up: ' + upH + 'h ' + upM + 'm ' + upS + 's &mdash; now: ' + fmtTs(now) + '<br>\n' +
'  Health checks run: ' + totalChecksRun + ' &mdash; Source checks run: ' + totalSourceChecksRun + ' &mdash; Download checks run: ' + totalDownloadChecksRun + '<br>\n' +
'  <a href="/data">Raw JSON</a>\n' +
'</p>\n' +
'<hr>\n' +
'<h2>Service health</h2>\n' +
'<table>\n' +
'  <thead><tr><th>Status</th><th>Name</th><th>URL</th><th>Uptime</th><th>Avg RT</th><th>p95 RT</th><th>Up/Total</th></tr></thead>\n' +
'  <tbody>' + mainChecks + '</tbody>\n' +
'</table>\n' +
'<p><small>Sparkline: \u2588 up &nbsp; \u2591 down &mdash; last 60 checks, right = newest</small></p>\n' +
'<hr>\n' +
'<h2>Subtitle source checks</h2>\n' +
'<p><small>\n' +
'  Data via <a href="https://sub.wyzie.io/api/status">sub.wyzie.io/api/status</a> (upstream caches 3 min, polled every 60s).<br>\n' +
'  Sparkline: \u2588 operational &nbsp; \u2592 degraded &nbsp; \u2591 down\n' +
'</small></p>\n' +
sourcesHtml +
'\n<hr>\n' +
'<h2>Download (/c/) checks</h2>\n' +
'<p><small>\n' +
'  Searches each source then downloads one subtitle via /c/ route. Polled every 120s.<br>\n' +
'  Sparkline: \u2588 all ok &nbsp; \u2592 search ok, download fail &nbsp; \u2591 fail\n' +
'</small></p>\n' +
downloadHtml +
'\n<hr>\n' +
'<p><small>wyzie-status port ' + PORT + ' &mdash; Node.js ' + process.version + '</small></p>\n' +
'</body>\n' +
'</html>';
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(function(req, res) {
  const path = (req.url || '/').split('?')[0];

  if (path === '/data') {
    const body = JSON.stringify(buildJsonResponse(), null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  } else if (path === '/') {
    const html = buildHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('wyzie-status listening on http://0.0.0.0:' + PORT);
  console.log('Health checks every ' + CHECK_INTERVAL_MS / 1000 + 's, source checks every ' + SOURCE_INTERVAL_MS / 1000 + 's, download checks every ' + DOWNLOAD_INTERVAL_MS / 1000 + 's');
  CHECKS.forEach(function(c) {
    console.log('  health: ' + c.name + '  ' + (typeof c.url === 'string' ? c.url : '(dynamic)'));
  });
  console.log('  source: https://sub.wyzie.io/api/status');
  console.log('  download: /c/ checks for ' + Object.keys(DOWNLOAD_TEST_QUERIES).join(', '));
});

// Run immediately then on their respective intervals
runChecks().then(function() { setInterval(runChecks, CHECK_INTERVAL_MS); });
runSourceChecks().then(function() { setInterval(runSourceChecks, SOURCE_INTERVAL_MS); });
runDownloadChecks().then(function() { setInterval(runDownloadChecks, DOWNLOAD_INTERVAL_MS); });
