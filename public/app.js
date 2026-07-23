const matchList = document.getElementById('match-list');
const emptyState = document.getElementById('empty-state');
const connectionDot = document.getElementById('connection-dot');
const statusFooter = document.getElementById('status-footer');
const filterChips = document.querySelectorAll('.filter-chip');

let currentFilter = 'ALL';
let previousScores = {}; // matchId -> "home-away" string, used to detect changes

// ---- Render a team logo image, falling back to initials if it fails ----
function logoHTML(logoUrl, initials) {
  if (!logoUrl) return initials;
  return `<img src="${logoUrl}" alt="${initials}" width="20" height="20" style="border-radius:50%;object-fit:contain;" onerror="this.outerHTML='${initials}'">`;
}

// ---- Build one match card's HTML from a match object ----
function matchCardHTML(m) {
  const isLive = m.status === 'LIVE';
  const isScheduled = m.status === 'SCHEDULED';

  let statusHTML;
  if (isLive) {
    statusHTML = `<span class="status-live"><span class="pulse-dot"></span>${m.minute ? m.minute + "'" : 'LIVE'}</span>`;
  } else if (isScheduled) {
    statusHTML = `<span class="status-ft">${m.kickoff || ''}</span>`;
  } else {
    statusHTML = `<span class="status-ft">FT</span>`;
  }

  let scoreHTML;
  if (isScheduled) {
    scoreHTML = `<div class="score-block vs">VS</div>`;
  } else {
    const homeClass = m.homeScore > m.awayScore ? 'scored' : '';
    const awayClass = m.awayScore > m.homeScore ? 'scored' : '';
    scoreHTML = `<div class="score-block"><span class="${homeClass}">${m.homeScore}</span><span class="dash">–</span><span class="${awayClass}">${m.awayScore}</span></div>`;
  }

  const bottomLeft = isScheduled
    ? `Kicks off at ${m.kickoff || 'TBD'}`
    : (m.lastEvent ? `<span class="goal-flash">⚽ ${m.lastEvent}</span>` : (isLive ? 'No goals yet' : 'Full time'));

  return `
    <div class="match-card ${isLive ? 'live' : ''}" data-id="${m.id}">
      <div class="card-top">
        <span class="league-tag">${m.league}</span>
        ${statusHTML}
      </div>
      <div class="teams-row">
        <div class="team">
          <div class="crest">${logoHTML(m.homeLogo, m.homeCrest)}</div>
          <div class="team-name">${m.homeTeam}</div>
        </div>
        ${scoreHTML}
        <div class="team right">
          <div class="crest">${logoHTML(m.awayLogo, m.awayCrest)}</div>
          <div class="team-name">${m.awayTeam}</div>
        </div>
      </div>
      <div class="card-bottom">
        <span>${bottomLeft}</span>
        <span>${m.venue || ''}</span>
      </div>
    </div>
  `;
}

// ---- Render the list, grouped into Live now / Upcoming ----
function render(cache) {
  const matches = cache.matches || [];

  if (matches.length === 0) {
    matchList.innerHTML = '';
    emptyState.style.display = 'block';
    emptyState.textContent = 'No live or upcoming matches right now — check back soon.';
    return;
  }
  emptyState.style.display = 'none';

  const live = matches.filter((m) => m.status === 'LIVE');
  const upcoming = matches.filter((m) => m.status === 'SCHEDULED');

  let html = '';
  if (live.length > 0) {
    html += `<div class="section-label">● Live now</div>`;
    html += live.map(matchCardHTML).join('');
  }
  if (upcoming.length > 0) {
    html += `<div class="section-label">Upcoming</div>`;
    html += upcoming.map(matchCardHTML).join('');
  }
  matchList.innerHTML = html;

  // Flash any card whose score changed since the last render
  matches.forEach((m) => {
    const scoreKey = `${m.homeScore}-${m.awayScore}`;
    if (previousScores[m.id] && previousScores[m.id] !== scoreKey) {
      const el = matchList.querySelector(`[data-id="${m.id}"]`);
      if (el) {
        el.classList.add('just-updated');
        setTimeout(() => el.classList.remove('just-updated'), 1200);
      }
    }
    previousScores[m.id] = scoreKey;
  });

  if (cache.lastUpdated) {
    const time = new Date(cache.lastUpdated).toLocaleTimeString();
    statusFooter.textContent = `LAST UPDATED ${time}`;
  }
}

// ---- Filter chip clicks ----
filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    filterChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    render(lastCache);
  });
});

// ---- SSE connection ----
let lastCache = { matches: [] };

function connect() {
  const source = new EventSource('/api/live-updates');

  source.onopen = () => {
    connectionDot.classList.remove('disconnected');
  };

  source.onmessage = (event) => {
    lastCache = JSON.parse(event.data);
    render(lastCache);
  };

  source.onerror = () => {
    connectionDot.classList.add('disconnected');
    statusFooter.textContent = 'CONNECTION LOST — RETRYING…';
    // EventSource retries automatically, no manual reconnect needed
  };
}

connect();
