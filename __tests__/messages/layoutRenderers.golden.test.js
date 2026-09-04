/**
 * Golden-output test for the status layouts.
 *
 * This is the safety net for the Cloud work: the self-hosted rendering path must keep
 * producing byte-identical embeds while the code underneath it is restructured (DTO,
 * adapters, limit guards). Snapshots are committed — a diff here means a customer's
 * status message changed, which is only ever allowed on purpose.
 *
 * The embed timestamp is stripped before snapshotting: it is `new Date()` at render time
 * and would make every run differ. Everything else is compared verbatim.
 */

import {
    renderDetailedLayout,
    renderCompactLayout,
    renderOverviewLayout,
    renderTreeLayout,
    renderMinimalLayout,
    getLayoutRenderer,
} from '../../messages/layoutRenderers.js';

/** Shape produced by services/statuspage.js for a self-hosted LIVCK page. */
const buildService = () => ({
    categories: [
        {
            id: 'ad41a2eb-c52e-4950-a4e3-ccd666a84728',
            name: 'Cloud - Platform',
            short_description: null,
            monitors: [
                { id: 'bf4fff51', name: 'Homepage', state: 'AVAILABLE' },
                { id: 'c3e6f4f0', name: 'Documentation', state: 'AVAILABLE' },
                { id: 'e3598379', name: 'Application Load-Balancer', state: 'AVAILABLE' },
            ],
        },
        {
            id: 'd722bc3e-219c-4bee-9e1a-bc9adf482210',
            name: 'Cloud - Edge',
            short_description: null,
            monitors: [
                { id: 'a1', name: 'Edge Frankfurt', state: 'UNAVAILABLE' },
                { id: 'a2', name: 'Edge Nürnberg', state: 'AVAILABLE' },
            ],
        },
        {
            id: 'be45000d-2280-48c1-8366-6d21e05b1df5',
            name: 'Zahlungsdienste',
            short_description: null,
            monitors: [
                { id: 'b1', name: 'Stripe', state: 'DEGRADED' },
            ],
        },
    ],
});

const STATUSPAGE = { name: 'status.livck.com', url: 'https://status.livck.com' };

/** Embeds carry a render-time timestamp; drop it so snapshots are stable. */
const normalize = (renderResult) => renderResult.map(({ embed, type }) => {
    const json = JSON.parse(JSON.stringify(embed.toJSON()));
    delete json.timestamp;
    return { type, embed: json };
});

const LAYOUTS = [
    ['DETAILED', renderDetailedLayout],
    ['COMPACT', renderCompactLayout],
    ['OVERVIEW', renderOverviewLayout],
    ['TREE', renderTreeLayout],
    ['MINIMAL', renderMinimalLayout],
];

describe('Layout golden output', () => {
    describe.each(LAYOUTS)('%s', (name, renderer) => {
        test.each(['de', 'en'])('renders unchanged (%s)', (locale) => {
            expect(normalize(renderer(buildService(), STATUSPAGE, locale))).toMatchSnapshot();
        });
    });

    test('empty statuspage renders unchanged', () => {
        for (const [, renderer] of LAYOUTS) {
            expect(normalize(renderer({ categories: [] }, STATUSPAGE, 'de'))).toMatchSnapshot();
        }
    });

    test('category without monitors renders unchanged', () => {
        const service = { categories: [{ id: 'x', name: 'Leer', monitors: [] }] };
        for (const [, renderer] of LAYOUTS) {
            expect(normalize(renderer(service, STATUSPAGE, 'de'))).toMatchSnapshot();
        }
    });

    test('missing category name falls back to the translated placeholder', () => {
        const service = { categories: [{ id: 'x', name: null, monitors: [{ id: 'm', name: 'Ding', state: 'AVAILABLE' }] }] };
        expect(normalize(renderDetailedLayout(service, STATUSPAGE, 'de'))).toMatchSnapshot();
    });
});

describe('getLayoutRenderer', () => {
    test.each([
        ['DETAILED', renderDetailedLayout],
        ['COMPACT', renderCompactLayout],
        ['OVERVIEW', renderOverviewLayout],
        ['TREE', renderTreeLayout],
        ['MINIMAL', renderMinimalLayout],
    ])('%s maps to its renderer', (key, expected) => {
        expect(getLayoutRenderer(key)).toBe(expected);
    });

    test('unknown layout falls back to DETAILED', () => {
        expect(getLayoutRenderer('DOES_NOT_EXIST')).toBe(renderDetailedLayout);
        expect(getLayoutRenderer(undefined)).toBe(renderDetailedLayout);
    });
});
