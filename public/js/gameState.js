function stateClass(state) {
  if (state === 'LIVE' || state === 'CRIT') return 'badge-live';
  if (state === 'FINAL' || state === 'OFF') return 'badge-final';
  return 'badge-upcoming';
}

function stateLabel(state) {
  if (state === 'LIVE') return 'LIVE';
  if (state === 'CRIT') return 'LIVE - CRIT';
  if (state === 'FINAL' || state === 'OFF') return 'FINAL';
  return 'Upcoming';
}
