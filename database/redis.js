import redis from 'redis';

const client = redis.createClient({
    url: `redis://${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
});

client.on('connect', () => { console.log('Connected to Redis') });

client.on('error', (err) => { console.error('Redis error:', err) });

client.connect();

export default client;
