const streamResolver = require('./streamResolver');

// Attach hasStreams/streamCount to each game. Shared by games, api, and wild routes.
async function decorateWithStreamInfo(games) {
  return Promise.all(games.map(async (game) => {
    const streams = await streamResolver.getStreams(game.id);
    return { ...game, hasStreams: streams.length > 0, streamCount: streams.length };
  }));
}

module.exports = { decorateWithStreamInfo };
