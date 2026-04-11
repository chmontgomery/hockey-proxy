/**
 * Wild schedule page: "Show Previous Games" toggle + live score polling.
 */
(function () {
  const container = document.getElementById('wild-schedule');
  if (!container) return;

  // --- Show Previous Games ---
  const showPastBtn = document.getElementById('show-past-btn');
  const pastGames = document.getElementById('past-games');
  const todayMarker = document.getElementById('today-marker');

  if (showPastBtn && pastGames) {
    showPastBtn.addEventListener('click', function () {
      pastGames.style.display = '';
      showPastBtn.remove();
      todayMarker.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // --- Live Score Polling ---
  const REFRESH_INTERVAL = 30000;

  async function refreshScores() {
    try {
      const res = await fetch('/api/wild');
      if (!res.ok) return;
      const data = await res.json();

      let hasLive = false;

      data.games.forEach(function (game) {
        const row = container.querySelector('[data-game-id="' + game.id + '"]');
        if (!row) return;

        if (game.gameState === 'LIVE' || game.gameState === 'CRIT') {
          hasLive = true;
        }

        // Update border class
        row.classList.remove('border-live', 'border-upcoming', 'border-muted');
        if (game.gameState === 'LIVE' || game.gameState === 'CRIT') {
          row.classList.add('border-live');
        } else if (game.gameState === 'FINAL' || game.gameState === 'OFF') {
          row.classList.add('border-muted');
        } else {
          row.classList.add('border-upcoming');
        }

        // Update scores
        var awayScoreEl = row.querySelector('[data-side="away"]');
        var homeScoreEl = row.querySelector('[data-side="home"]');
        if (awayScoreEl && game.awayScore != null) awayScoreEl.textContent = game.awayScore;
        if (homeScoreEl && game.homeScore != null) homeScoreEl.textContent = game.homeScore;

        // Update status section
        var statusEl = row.querySelector('.sched-status');
        if (!statusEl) return;

        if (game.gameState === 'LIVE' || game.gameState === 'CRIT') {
          var clockText = game.clock ? 'P' + game.period + ' ' + (game.inIntermission ? 'INT' : game.clock) : '';
          statusEl.innerHTML =
            '<span class="badge badge-live sched-badge">LIVE</span>' +
            (clockText ? '<span class="sched-clock">' + clockText + '</span>' : '');
        } else if (game.gameState === 'FINAL' || game.gameState === 'OFF') {
          // Game just ended — rebuild the status as W/L result
          var matchup = row.querySelector('.sched-matchup');
          if (matchup && game.awayScore != null && game.homeScore != null) {
            var text = matchup.textContent;
            var wildIsHome = text.indexOf('MIN') > text.indexOf('\u2014') || text.indexOf('MIN') > text.indexOf('\u2013');
            var wildScore = wildIsHome ? game.homeScore : game.awayScore;
            var oppScore = wildIsHome ? game.awayScore : game.homeScore;
            var won = wildScore > oppScore;
            var cls = won ? 'result-win' : 'result-loss';
            var label = (won ? 'W ' : 'L ') + wildScore + '-' + oppScore;
            statusEl.innerHTML = '<span class="' + cls + '">' + label + '</span>';
          } else {
            statusEl.innerHTML = '<span class="badge badge-final sched-badge">FINAL</span>';
          }
        }
      });

      // Stop polling if no live games
      if (!hasLive && data.games.length > 0 && data.games.every(function (g) {
        return g.gameState === 'FINAL' || g.gameState === 'OFF' || g.gameState === 'FUT';
      })) {
        clearInterval(pollInterval);
      }
    } catch (err) {
      console.error('Wild refresh failed:', err);
    }
  }

  var pollInterval = setInterval(refreshScores, REFRESH_INTERVAL);
})();
