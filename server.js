import dotenv from 'dotenv';
import models from './models/index.js';
import bot from './discord/bot.js';
import { startUpdateLoop } from './services/updateLoop.js';

dotenv.config();

const client = await bot(models);

startUpdateLoop(client);
