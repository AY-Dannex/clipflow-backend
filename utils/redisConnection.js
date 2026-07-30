const IORedis = require('ioredis');

// BullMQ requires this specific option to be set on the Redis connection
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

module.exports = connection;