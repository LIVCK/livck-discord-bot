/**
 * Nothing the bot calls is on its way out of discord.js.
 *
 * discord.js 14 still accepts these but prints a DeprecationWarning, and 15 drops them
 * without one: the `ready` event no longer fires (so the "Logged in" line is never written)
 * and `ephemeral: true` is ignored, which posts an admin's reply for the whole channel to see.
 * Neither would fail a test that mocks the interaction, so this reads the source instead.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const sources = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(relative);
    return entry.name.endsWith('.js') ? [relative] : [];
});

const FILES = [...sources('discord'), ...sources('handlers'), ...sources('services'), ...sources('util'), 'server.js'];

const offenders = (pattern) => FILES.flatMap((file) =>
    fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
        .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
        .filter(({ line }) => pattern.test(line) && !/^\s*(\/\/|\*)/.test(line))
        .map(({ at }) => at));

test('replies are made ephemeral with a flag, not the `ephemeral` option', () => {
    expect(offenders(/\bephemeral\s*:/)).toEqual([]);
});

test('the login line listens for clientReady, not ready', () => {
    expect(offenders(/\.(on|once)\(\s*['"]ready['"]/)).toEqual([]);
});

test('no fetchReply, which 15 replaces with withResponse', () => {
    expect(offenders(/\bfetchReply\s*:/)).toEqual([]);
});
