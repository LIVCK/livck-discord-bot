/**
 * The frozen corpus, through the whole rendering chain, with the result written down.
 *
 * The matrix and the fuzzer assert PROPERTIES — nothing is over a limit, nothing leaks a key.
 * That catches a message Discord would reject. It does not catch a message that is merely
 * wrong: a service quietly missing, a count off by one, a group that stopped being rendered.
 *
 * This asserts the OUTPUT. Twenty-one payloads, generated once with a fixed seed from
 * `scripts/generate-corpus.js` and committed as bytes, are run through the real adapter, the
 * real DTO and all five real renderers in both languages, and the result is recorded. Any
 * change to any of those shows up as a diff on a snapshot with a name that says which payload
 * and which layout — which is the difference between "something broke" and "the compact layout
 * of a page with a hiding group changed".
 *
 * The corpus is deliberately NOT generated at test time. A generator called per run makes
 * every run a different test: a failure nobody can reproduce and a pass that proves nothing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { toSnapshot as cloudSnapshot } from '../../providers/cloud.js';
import { toSnapshot as selfHostedSnapshot } from '../../providers/selfHosted.js';
import Statuspage from '../../services/statuspage.js';
import { getLayoutRenderer } from '../../messages/layoutRenderers.js';

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/corpus');

const LAYOUTS = ['DETAILED', 'COMPACT', 'OVERVIEW', 'TREE', 'MINIMAL'];
const LOCALES = ['de', 'en'];

const PAGE = { url: 'https://corpus.example', name: 'corpus' };

const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.json')).sort();

/** The corpus must be there — an empty run would pass silently. */
test('the corpus is present', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
});

const load = (file) => JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));

const snapshotFor = (file) => {
    const payload = load(file);

    return file.startsWith('selfhosted-')
        // Through the real normalisation: the API answers with an object keyed by uuid.
        ? selfHostedSnapshot({ categories: Statuspage.normalizeCategories(payload), alerts: [] }, PAGE)
        : cloudSnapshot(payload, PAGE);
};

/** Everything except the wall clock, which changes on every run by design. */
const stable = (embed) => {
    const { timestamp, ...rest } = embed;
    return rest;
};

describe.each(files)('%s', (file) => {
    test.each(LAYOUTS)('%s in de and en', (layout) => {
        const snapshot = snapshotFor(file);
        const render = getLayoutRenderer(layout);

        const output = Object.fromEntries(LOCALES.map((locale) => [
            locale,
            render(snapshot, locale).map(({ embed, type }) => ({ type, embed: stable(embed.toJSON()) })),
        ]));

        expect(output).toMatchSnapshot();
    });

    test('the snapshot the renderers were given', () => {
        // The adapter's own output, so a change in the DTO is visible on its own rather than
        // only through whatever the renderers happened to do with it.
        const { groups, alerts, overall, defaultLocale, locales } = snapshotFor(file);

        expect({
            overall,
            defaultLocale,
            locales,
            groups: groups.map((g) => ({
                name: g.name,
                status: g.status,
                childrenTotal: g.childrenTotal,
                services: g.services.map((s) => ({ name: s.name, status: s.status, path: s.path })),
            })),
            alerts: alerts.map((a) => ({ kind: a.kind, state: a.state, severity: a.severity, updates: a.updates.length })),
        }).toMatchSnapshot();
    });
});
