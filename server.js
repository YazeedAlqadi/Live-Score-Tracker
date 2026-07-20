require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 25000);
const USE_MOCK_DATA = process.env.USE_MOCK_DATA === 'false';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'free-api-live-football-data.p.rapidapi.com';

// ---- In-memory cache -------------------------------------------------
// This is the whole point of the polling loop: we hit the real API on
// our own schedule, not once per visitor. Every client reads from this.
let cache = {
  matches: [],
  lastUpdated: null,
};

// Clients currently listening for live updates (SSE connections)
let sseClients = [];

// ---- Normalize the RapidAPI response into our frontend's shape --------
// NOTE: this API's exact field names weren't verifiable from outside —
// I've mapped the most likely field names based on common patterns for
// this kind of endpoint. If fields come back undefined, see the
// console.log(JSON.stringify(...)) below: it prints one raw match the
// first time data loads, so you can compare real field names against
// this function and adjust the m.xxx paths to match.
function normalizeMatch(m) {
  const statusRaw = (m.status || m.matchStatus || '').toUpperCase();
  let status = 'SCHEDULED';
  if (statusRaw.includes('LIVE') || statusRaw.includes('PLAY') || statusRaw.includes('HT')) status = 'LIVE';
  if (statusRaw.includes('FT') || statusRaw.includes('FINISH')) status = 'FT';

  const home = m.homeTeam || m.home || {};
  const away = m.awayTeam || m.away || {};

  return {
    id: String(m.id || m.matchId || m.fixtureId),
    league: m.league?.name || m.competition?.name || m.tournamentName || 'Unknown league',
    status,
    minute: m.minute || m.time || null,
    homeTeam: home.name || home.shortName || 'Home',
    homeCrest: (home.shortName || home.name || 'HOM').slice(0, 3).toUpperCase(),
    awayTeam: away.name || away.shortName || 'Away',
    awayCrest: (away.shortName || away.name || 'AWY').slice(0, 3).toUpperCase(),
    homeScore: m.homeScore ?? home.score ?? null,
    awayScore: m.awayScore ?? away.score ?? null,
    venue: m.venue || m.stadium || '',
    kickoff: m.startTime
      ? new Date(m.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null,
    lastEvent: null,
  };
}

// ---- Fetch fresh data (real API or mock file) -------------------------
async function fetchMatches() {
  if (USE_MOCK_DATA) {
    const raw = fs.readFileSync(path.join(__dirname, 'mock-data.json'), 'utf-8');
    return JSON.parse(raw);
  }

  if (!RAPIDAPI_KEY) {
    console.error('RAPIDAPI_KEY is missing. Set USE_MOCK_DATA=true or add a key to .env');
    return cache.matches;
  }

  const res = await fetch(`https://${RAPIDAPI_HOST}/football-current-live`, {
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
  });

  if (!res.ok) {
    console.error(`RapidAPI error: ${res.status} ${res.statusText}`);
    return cache.matches;
  }

  const data = await res.json();
  // Confirmed shape from live testing: { status: "success", response: { live: [...] } }
  const rawMatches = data.response?.live || data.response || data.data || data.matches || data;

  if (!Array.isArray(rawMatches)) {
    console.error('Unexpected response shape from RapidAPI. Raw response:', JSON.stringify(data).slice(0, 500));
    return cache.matches;
  }

  if (rawMatches.length > 0 && !cache.loggedSample) {
    console.log('Sample raw match from API (compare field names to normalizeMatch):');
    console.log(JSON.stringify(rawMatches[0], null, 2));
    cache.loggedSample = true;
  }

  return rawMatches.map(normalizeMatch);
}

// ---- Push the latest cache to every connected browser -----------------
function broadcast() {
  const payload = `data: ${JSON.stringify(cache)}\n\n`;
  sseClients.forEach((client) => client.res.write(payload));
}

// ---- The polling loop ---------------------------------------------------
async function pollLoop() {
  try {
    const allMatches = await fetchMatches();
    // Keep live and upcoming matches — drop only finished ones.
    const relevant = allMatches.filter((m) => m.status === 'LIVE' || m.status === 'SCHEDULED');
    cache = { matches: relevant, lastUpdated: new Date().toISOString() };
    broadcast();
    console.log(`[${new Date().toLocaleTimeString()}] ${relevant.length} match(es) (live + upcoming)`);
  } catch (err) {
    console.error('Poll loop failed:', err.message);
  }
}

// ---- Routes ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// One-shot fetch — useful for initial page load before SSE kicks in
app.get('/api/live-matches', (req, res) => {
  res.json(cache);
});

// Live stream — browser keeps this connection open and receives pushes
app.get('/api/live-updates', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Send what we already have immediately, so the page isn't empty
  // while it waits for the next poll cycle.
  res.write(`data: ${JSON.stringify(cache)}\n\n`);

  const client = { id: Date.now(), res };
  sseClients.push(client);

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c.id !== client.id);
  });
});

app.listen(PORT, () => {
  console.log(`Live score tracker running at http://localhost:${PORT}`);
  console.log(`Mode: ${USE_MOCK_DATA ? 'MOCK DATA' : 'REAL API'}`);
  pollLoop(); // run once immediately on startup
  setInterval(pollLoop, POLL_INTERVAL_MS);
});
