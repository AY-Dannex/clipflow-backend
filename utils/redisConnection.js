const IORedis = require('ioredis');

// BullMQ requires this specific option to be set on the Redis connection
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Log what's actually happening with the connection — without this,
// a silent disconnect/reconnect loop is invisible and looks like
// everything is fine when it isn't.
connection.on('connect', () => console.log('[Redis] connecting...'));
connection.on('ready', () => console.log('[Redis] ready'));
connection.on('error', (err) => console.error('[Redis] error:', err.message));
connection.on('close', () => console.log('[Redis] connection closed'));
connection.on('reconnecting', (delay) => console.log(`[Redis] reconnecting in ${delay}ms`));
connection.on('end', () => console.log('[Redis] connection ended'));

module.exports = connection;