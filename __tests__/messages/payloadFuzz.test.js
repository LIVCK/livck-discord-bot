/**
 * A few hundred payloads nobody wrote down, held to the same rules.
 *
 * The matrix covers the shapes somebody thought of. This covers the ones nobody did: a tree
 * assembled at random from the pieces the schema allows, rendered every way a subscription can
 * ask for it, and required to satisfy the properties that separate a message a customer can
 * read from one Discord rejects.
 *
 * SEEDED, so a failure is a bug and not a coincidence. The seed is printed with any failure
 * and can be set with FUZZ_SEED to reproduce one exactly. The count is deliberately modest so
 * this stays part of the ordinary suite rather than something run on Fridays; raise it with
 * FUZZ_RUNS when hunting.
 */

import {
    CLOUD_STATUSES, NAME_SHAPES, cloudComponent, cloudIncident, cloudMaintenance, cloudNotice,
    cloudFull, resetIds,
} from '../fixtures/payloadFactory.js';

import { toSnapshot } from '../../providers/cloud.js';
import { getLayoutRenderer } from '../../messages/layoutRenderers.js';
import { DISCORD_LIMITS, embedLength } from '../../util/discordLimits.js';
import { hashPayload } from '../../util/messageSync.js';

const RUNS = Number(process.env.FUZZ_RUNS || 250);
const SEED = Number(process.env.FUZZ_SEED || 20260912);

const LAYOUTS = ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL'];
const LOCALES = ['de', 'en', 'fr'];
const PAGE = { url: 'https://fuzz.example', name: 'fuzz' };

/** mulberry32 — small, fast, and the same sequence on every machine. */
const rngFrom = (seed) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const NAME_VALUES = Object.values(NAME_SHAPES);

/** A random subtree, bounded so a run stays quick. */
const randomNode = (rng, depth) => {
    const isGroup = depth > 0 && rng() < 0.55;

    if (!isGroup) {
        return cloudComponent({
            status: CLOUD_STATUSES[Math.floor(rng() * CLOUD_STATUSES.length)],
            name: NAME_VALUES[Math.floor(rng() * NAME_VALUES.length)],
            visible: rng() > 0.1,
        });
    }

    const hides = rng() < 0.25;
    const childCount = hides ? 0 : Math.floor(rng() * 6);

    return cloudComponent({
        group: true,
        status: CLOUD_STATUSES[Math.floor(rng() * CLOUD_STATUSES.length)],
        name: NAME_VALUES[Math.floor(rng() * NAME_VALUES.length)],
        children: Array.from({ length: childCount }, () => randomNode(rng, depth - 1)),
        hidesChildren: hides,
        childrenTotal: hides ? 66 : null,
        childrenHidden: hides ? 66 : null,
        visible: rng() > 0.05,
    });
};

const randomPayload = (rng) => {
    const roll = rng();

    return cloudFull({
        name: NAME_VALUES[Math.floor(rng() * NAME_VALUES.length)],
        components: Array.from({ length: Math.floor(rng() * 8) }, () => randomNode(rng, 3)),
        incidents: roll < 0.3 ? [cloudIncident({ updates: Math.floor(rng() * 4) })] : [],
        notices: roll > 0.8 ? [cloudNotice({ updates: Math.floor(rng() * 3) })] : [],
        activeMaintenances: roll > 0.6 && roll < 0.8 ? [cloudMaintenance({ state: 'in_progress' })] : [],
        scheduledMaintenances: roll < 0.15 ? [cloudMaintenance()] : [],
    });
};

const textOf = (embed) => [
    embed.title ?? '', embed.description ?? '', embed.footer?.text ?? '',
    ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
].join('\n');

/** Everything that must be true of a rendered message, whatever produced it. */
const problemsWith = (embed) => {
    const problems = [];
    const text = textOf(embed);

    if (embedLength(embed) > DISCORD_LIMITS.MESSAGE_EMBED_TOTAL) problems.push('over the 6000 budget');
    if ((embed.title ?? '').length > DISCORD_LIMITS.EMBED_TITLE) problems.push('title too long');
    if ((embed.description ?? '').length > DISCORD_LIMITS.EMBED_DESCRIPTION) problems.push('description too long');
    if ((embed.fields ?? []).length > DISCORD_LIMITS.EMBED_FIELDS) problems.push('too many fields');
    if (!(embed.title ?? '').trim()) problems.push('empty title');

    for (const field of embed.fields ?? []) {
        if (!field.name.length) problems.push('empty field name');
        if (!field.value.length) problems.push('empty field value');
        if (field.value.length > DISCORD_LIMITS.EMBED_FIELD_VALUE) problems.push('field value too long');
        if (field.name.length > DISCORD_LIMITS.EMBED_FIELD_NAME) problems.push('field name too long');
    }

    if (/\b(messages|commands)\.[a-z_]+\.[a-z_.]+/i.test(text)) problems.push('translation key leaked');
    if (/\bundefined\b|\[object Object\]|\bNaN\b/.test(text)) problems.push('placeholder leaked');
    // How many services a hiding group is hiding is the one thing it exists to hide.
    if (text.includes('66')) problems.push('hidden child count leaked');

    return problems;
};

describe(`${RUNS} random payloads (seed ${SEED})`, () => {
    test('every one of them renders into something Discord accepts and a reader can use', () => {
        const rng = rngFrom(SEED);
        const failures = [];

        for (let run = 0; run < RUNS; run += 1) {
            resetIds();
            const payload = randomPayload(rng);

            let snapshot;
            try {
                snapshot = toSnapshot(payload, PAGE);
            } catch (error) {
                failures.push({ run, stage: 'adapter', error: error.message, payload });
                continue;
            }

            for (const layout of LAYOUTS) {
                for (const locale of LOCALES) {
                    try {
                        for (const { embed } of getLayoutRenderer(layout)(snapshot, locale)) {
                            const problems = problemsWith(embed.toJSON());
                            if (problems.length > 0) failures.push({ run, layout, locale, problems });
                        }
                    } catch (error) {
                        failures.push({ run, layout, locale, stage: 'render', error: error.message });
                    }
                }
            }
        }

        if (failures.length > 0) {
            // The seed is what makes this reproducible: FUZZ_SEED=<n> re-runs the same sequence.
            throw new Error(
                `${failures.length} failure(s) with seed ${SEED}. First three:\n` +
                `${JSON.stringify(failures.slice(0, 3), null, 2)}`
            );
        }
    }, 120000);

    test('and renders each of them the same way twice', () => {
        // Non-determinism would change the content hash every cycle and edit every message in
        // every channel for nothing.
        const first = rngFrom(SEED);
        const second = rngFrom(SEED);

        for (let run = 0; run < Math.min(RUNS, 60); run += 1) {
            resetIds();
            const a = toSnapshot(randomPayload(first), PAGE);
            resetIds();
            const b = toSnapshot(randomPayload(second), PAGE);

            for (const layout of LAYOUTS) {
                const left = getLayoutRenderer(layout)(a, 'de').map((m) => m.embed);
                const right = getLayoutRenderer(layout)(b, 'de').map((m) => m.embed);

                expect(hashPayload({ embeds: right })).toBe(hashPayload({ embeds: left }));
            }
        }
    }, 120000);
});
