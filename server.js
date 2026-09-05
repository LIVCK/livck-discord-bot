import dotenv from 'dotenv';

dotenv.config();

// BEFORE anything else is imported. `models/index.js` opens a database connection and the
// command modules open a Redis one at import time, and a missing variable there surfaces as
// `TypeError: Invalid URL` from inside node-redis rather than as the name of what is missing.
const { requireEnv } = await import('./util/env.js');
requireEnv();

const models = (await import('./models/index.js')).default;
const bot = (await import('./discord/bot.js')).default;
const { startUpdateLoop } = await import('./services/updateLoop.js');

const client = await bot(models);

startUpdateLoop(client);
