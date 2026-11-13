// Loaded with `node --require` into the real bot process.
//
// 1. Every @discordjs/rest client it creates — the bot's own and the one that registers
//    commands — talks to the simulated Discord. The gateway address follows from REST
//    (`GET /gateway/bot`), so nothing else needs bending.
// 2. `.env` is NOT read. server.js calls dotenv.config(), which fills in whatever the harness
//    did not set from the developer's own .env — real emoji ids, real tokens, real database
//    names. The simulation sets everything it means; anything else must stay unset.
//
// Both are resolved from the bot's own directory, so this works for an older checkout too.
const from = { paths: [process.cwd()] };
require(require.resolve('@discordjs/rest', from)).DefaultRestOptions.api = process.env.SIM_DISCORD_API;
const dotenv = require(require.resolve('dotenv', from));
dotenv.config = () => ({ parsed: {} });

// 3. An older checkout has its 15-second cycle as a constant (UPDATE_INTERVAL_MS came later).
//    For a rollout from such a version, that one timer — and only that one, recognised by where
//    it is set — runs at the simulation's pace. Everything else keeps its own timing.
if (process.env.SIM_FORCE_INTERVAL_MS) {
    const original = global.setTimeout;
    const forced = Number(process.env.SIM_FORCE_INTERVAL_MS);
    const patched = function setTimeout(callback, ms, ...args) {
        if (ms === 15000 && /services[\\/]updateLoop\.js/.test(new Error().stack)) ms = forced;
        return original.call(this, callback, ms, ...args);
    };
    Object.defineProperties(patched, Object.getOwnPropertyDescriptors(original));
    global.setTimeout = patched;
}
