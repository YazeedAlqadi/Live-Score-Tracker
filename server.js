require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 25000);
const USE_MOCK_DATA = process.env.USE_MOCK_DATA === 'true';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'sportapi7.p.rapidapi.com';
const FOOTBALL_CATEGORY_ID = 1; // confirmed by your own curl example

// ---- In-memory cache -------------------------------------------------
// This is the whole point of the polling loop: we hit the real API on
// our own schedule, not once per visitor. Every client reads from this.
let cache = {
  matches: [],
  lastUpdated: null,
};

// Clients currently listening for live updates (SSE connections)
let sseClients = [];

// ---- Normalize a SofaScore-style "event" into our frontend's shape ----
// Known SofaScore field names (used by sportapi7 and similar clones):
// event.status.type: "notstarted" | "inprogress" | "finished" | "postponed" etc.
// event.homeTeam / event.awayTeam: { name, shortName }
// event.homeScore.current / event.awayScore.current
// event.tournament.name, event.startTimestamp (unix seconds)
function normalizeMatch(ev) {
  const statusType = (ev.status?.type || '').toLowerCase();
  let status = 'SCHEDULED';
  if (statusType.includes('progress')) status = 'LIVE';
  if (statusType.includes('finish')) status = 'FT';
  if (statusType.includes('notstarted') || statusType.includes('scheduled')) status = 'SCHEDULED';

  const startDate = ev.startTimestamp ? new Date(ev.startTimestamp * 1000) : null;

  return {
    id: String(ev.id),
    league: ev.tournament?.name || ev.tournament?.uniqueTournament?.name || 'Unknown league',
    status,
    minute: ev.time?.currentPeriodStartTimestamp
      ? Math.max(0, Math.floor((Date.now() / 1000 - ev.time.currentPeriodStartTimestamp) / 60))
      : (ev.statusTime || null),
    homeTeam: ev.homeTeam?.name || 'Home',
    homeCrest: (ev.homeTeam?.shortName || ev.homeTeam?.name || 'HOM').slice(0, 3).toUpperCase(),
    homeLogo: ev.homeTeam?.id ? `/api/team-logo/${ev.homeTeam.id}` : null,
    awayTeam: ev.awayTeam?.name || 'Away',
    awayCrest: (ev.awayTeam?.shortName || ev.awayTeam?.name || 'AWY').slice(0, 3).toUpperCase(),
    awayLogo: ev.awayTeam?.id ? `/api/team-logo/${ev.awayTeam.id}` : null,
    homeScore: ev.homeScore?.current ?? null,
    awayScore: ev.awayScore?.current ?? null,
    venue: ev.venue?.name || '',
    kickoffDate: startDate ? startDate.toDateString() : null,
    kickoff: startDate
      ? startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null,
    lastEvent: null,
  };
}

let sampleLogged = false;

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

  const headers = {
    'x-rapidapi-key': RAPIDAPI_KEY,
    'x-rapidapi-host': RAPIDAPI_HOST,
  };

  // Live matches
  let rawLive = [];
  try {
    const liveRes = await fetch(`https://${RAPIDAPI_HOST}/api/v1/sport/football/events/live`, { headers });
    if (liveRes.ok) {
      const liveData = await liveRes.json();
      rawLive = liveData.events || [];
    } else {
      console.error(`Live endpoint error: ${liveRes.status} ${liveRes.statusText}`);
    }
  } catch (e) {
    console.error('Live fetch failed:', e.message);
  }

  // Today's scheduled matches — same pattern as your confirmed curl test
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let rawScheduled = [];
  try {
    const schedRes = await fetch(
      `https://${RAPIDAPI_HOST}/api/v1/category/${FOOTBALL_CATEGORY_ID}/scheduled-events/${todayStr}`,
      { headers }
    );
    if (schedRes.ok) {
      const schedData = await schedRes.json();
      rawScheduled = schedData.events || [];
    } else {
      console.error(`Scheduled endpoint error: ${schedRes.status} ${schedRes.statusText}`);
    }
  } catch (e) {
    console.error('Scheduled fetch failed:', e.message);
  }

  const allEvents = [...rawLive, ...rawScheduled];

  if (allEvents.length > 0 && !sampleLogged) {
    console.log('Sample raw event (compare field names to normalizeMatch):');
    console.log(JSON.stringify(allEvents[0], null, 2));
    sampleLogged = true;
  }

  return allEvents.map(normalizeMatch);
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
    const today = new Date().toDateString();
    // Keep: any live match, and scheduled matches happening today only.
    const relevant = allMatches.filter((m) => {
      if (m.status === 'LIVE') return true;
      if (m.status === 'SCHEDULED') return m.kickoffDate === today;
      return false;
    });
    cache = { matches: relevant, lastUpdated: new Date().toISOString() };
    broadcast();
    console.log(`[${new Date().toLocaleTimeString()}] ${relevant.length} match(es) (live + today's upcoming)`);
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

// Proxy team logos through our own server so the browser never needs
// the RapidAPI key directly (img tags can't send custom headers).
app.get('/api/team-logo/:id', async (req, res) => {
  try {
    const imgRes = await fetch(`https://${RAPIDAPI_HOST}/api/v1/team/${req.params.id}/image`, {
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST,
      },
    });
    if (!imgRes.ok) return res.status(404).end();
    res.set('Content-Type', imgRes.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400'); // logos don't change often
    imgRes.body.pipe(res);
  } catch (e) {
    res.status(500).end();
  }
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
