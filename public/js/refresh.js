/**
 * Auto-refresh game data on the home page.
 * Polls /api/games every 30 seconds for live score updates.
 */
(function () {
  const container = document.getElementById('games-container');
  if (!container) return;

  const date = container.dataset.date;
  const REFRESH_INTERVAL = 30000; // 30 seconds

  async function refreshGames() {
    try {
      const res = await fetch(`/api/games?date=${date}`);
      if (!res.ok) return;
      const data = await res.json();

      data.games.forEach(game => {
        const card = container.querySelector(`[data-game-id="${game.id}"]`);
        if (!card) return;

        // Update scores
        const teams = card.querySelectorAll('.team');
        if (teams[0]) updateTeamScore(teams[0], game.away);
        if (teams[1]) updateTeamScore(teams[1], game.home);

        // Update badge
        const badge = card.querySelector('.badge');
        if (badge) {
          badge.className = 'badge ' + stateClass(game.gameState);
          badge.textContent = stateLabel(game.gameState);
        }

        // Update clock
        const clockEl = card.querySelector('.game-clock');
        const clockText = game.clock ? `P${game.period} - ${game.inIntermission ? 'INT' : game.clock}` : null;
        if (clockText && (game.gameState === 'LIVE' || game.gameState === 'CRIT')) {
          if (clockEl) {
            clockEl.textContent = clockText;
          } else {
            const statusEl = card.querySelector('.game-status');
            if (statusEl) {
              const span = document.createElement('span');
              span.className = 'game-clock';
              span.textContent = clockText;
              statusEl.appendChild(span);
            }
          }
        } else if (clockEl) {
          clockEl.remove();
        }

        // Update watch button
        const actions = card.querySelector('.game-actions');
        if (actions && game.hasStreams) {
          const existing = actions.querySelector('.btn-watch');
          if (!existing) {
            actions.innerHTML = `<a href="/watch/${game.id}?date=${date}" class="btn btn-watch">Watch (${game.streamCount})</a>`;
          }
        }
      });
    } catch (err) {
      console.error('Refresh failed:', err);
    }
  }

  function updateTeamScore(el, team) {
    let scoreEl = el.querySelector('.score');
    if (team.score != null) {
      if (scoreEl) {
        scoreEl.textContent = team.score;
      } else {
        scoreEl = document.createElement('span');
        scoreEl.className = 'score';
        scoreEl.textContent = team.score;
        el.appendChild(scoreEl);
      }
    }
  }

  setInterval(refreshGames, REFRESH_INTERVAL);
})();
