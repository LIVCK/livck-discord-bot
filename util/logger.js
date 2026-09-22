/**
 * Leveled logger with repeat suppression.
 *
 * Two problems this solves, both visible in production logs today:
 *
 *  1. VOLUME. The update loop wrote several lines per statuspage per cycle. At 500 pages
 *     on a 15s loop that is >2000 lines/minute before anything has gone wrong. Those lines
 *     are `debug` now; `info` stays a per-cycle summary.
 *
 *  2. REPETITION. A single expired domain produced one full stack trace every 15 seconds —
 *     ~5760 entries a day, all identical. `once()` keeps the first occurrence of a given
 *     message per key and stays quiet until the message actually changes.
 *
 * Level via LOG_LEVEL (error|warn|info|debug), default `info`.
 */

import { classifyError, isExpectedFailure } from './errors.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const resolveLevel = () => {
    const raw = (process.env.LOG_LEVEL || '').toLowerCase();
    if (raw in LEVELS) return LEVELS[raw];
    // Jest renders every console.warn with a stack trace; keep test output about the tests.
    if (process.env.NODE_ENV === 'test') return LEVELS.error;
    return LEVELS.info;
};

let currentLevel = resolveLevel();

/** Re-read LOG_LEVEL. Only needed by tests that flip the env var. */
export const refreshLevel = () => {
    currentLevel = resolveLevel();
};

const enabled = (level) => LEVELS[level] <= currentLevel;

/**
 * Last message logged per dedupe key. Bounded so a rotating key space (e.g. one key per
 * statuspage) cannot grow without limit — statuspages are deleted, keys are not.
 */
const lastSeen = new Map();
const MAX_DEDUPE_KEYS = 10_000;

const emit = (level, args) => {
    if (!enabled(level)) return;
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(...args);
};

export const logger = {
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('debug', args),

    /**
     * Log only when `message` differs from the last message logged under `key`.
     *
     * Returns true when it actually logged, so callers can count distinct incidents rather
     * than attempts.
     *
     * @param {string} key - dedupe scope, e.g. `statuspage:42`
     * @param {'error'|'warn'|'info'|'debug'} level
     * @param {string} message
     */
    once(key, level, message) {
        if (lastSeen.get(key) === message) return false;

        if (lastSeen.size >= MAX_DEDUPE_KEYS) {
            const oldest = lastSeen.keys().next().value;
            if (oldest !== undefined) lastSeen.delete(oldest);
        }
        lastSeen.set(key, message);

        emit(level, [message]);
        return true;
    },

    /** Forget a dedupe key, so the next occurrence logs again (used on recovery). */
    resetOnce(key) {
        lastSeen.delete(key);
    },

    /**
     * Log a failed statuspage fetch as ONE line — no stack for the routine kinds
     * (DNS, timeout, HTTP status, TLS). An unclassified error keeps its stack, because
     * that is the case where it helps.
     *
     * @param {string} scope - log prefix, e.g. `[UpdateLoop]`
     * @param {string} url
     * @param {Error} error
     * @param {string} [dedupeKey] - when given, repeats of the same line are suppressed
     * @returns {{kind: string, status: number|null, detail: string, expected: boolean}}
     */
    failure(scope, url, error, dedupeKey = null) {
        const info = classifyError(error);
        const line = `${scope} ${url} failed: ${info.kind} (${info.detail})`;

        if (!isExpectedFailure(info.kind)) {
            // Unexpected: always logged, always with the stack.
            emit('error', [line, error]);
            return info;
        }

        if (dedupeKey) {
            logger.once(dedupeKey, 'warn', line);
        } else {
            emit('warn', [line]);
        }

        return info;
    },
};

export default logger;
