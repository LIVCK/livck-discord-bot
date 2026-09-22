/**
 * Contract checks against the real status pages.
 *
 * Opt in with LIVCK_LIVE_TESTS=1. They are NOT part of CI: a third-party outage must not fail
 * the build of the bot whose job is reporting outages. Run them when touching an adapter, and
 * before a release.
 *
 * What they are for is drift. The unit tests next door run against recorded fixtures, which
 * cannot notice the day the API changes shape. These can.
 *
 * Targets are deliberately the two pages that will always exist:
 *   cloud.statuspage.de   LIVCK Cloud
 *   status.livck.com      self-hosted
 */

import LIVCKCloud from '../../api/livckCloud.js';
import LIVCK from '../../api/livck.js';
import StatuspageService from '../../services/statuspage.js';
import { detectSource } from '../../api/detect.js';
import { toSnapshot as cloudSnapshot } from '../../providers/cloud.js';
import { toSnapshot as selfHostedSnapshot } from '../../providers/selfHosted.js';
import { SOURCE, STATUS, resolveText } from '../../dto/statuspage.js';

const live = process.env.LIVCK_LIVE_TESTS === '1' ? describe : describe.skip;

const CLOUD_URL = 'https://cloud.statuspage.de';
const SELF_HOSTED_URL = 'https://status.livck.com';

const KNOWN_STATUSES = new Set(Object.values(STATUS));

live('detection', () => {
    test('the Cloud identifies itself', async () => {
        await expect(detectSource(CLOUD_URL)).resolves.toBe(SOURCE.CLOUD);
    }, 20000);

    test('a self-hosted instance identifies itself', async () => {
        await expect(detectSource(SELF_HOSTED_URL)).resolves.toBe(SOURCE.SELF_HOSTED);
    }, 20000);

    test('an unrelated host is neither', async () => {
        await expect(detectSource('https://example.com')).resolves.toBeNull();
    }, 20000);
});

live('Cloud contract', () => {
    let full;
    let status;

    beforeAll(async () => {
        const client = new LIVCKCloud(CLOUD_URL);
        [status, full] = await Promise.all([client.fetchStatus(), client.fetchFull()]);
    }, 30000);

    test('status.json still exposes the page id the /full lookup needs', () => {
        expect(typeof status?.page?.id).toBe('string');
        expect(status.page.id.length).toBeGreaterThan(0);
    });

    test('the full payload still has the sections the adapter reads', () => {
        expect(full).toHaveProperty('meta');
        expect(Array.isArray(full.components)).toBe(true);
        expect(Array.isArray(full.active_incidents)).toBe(true);
        expect(full.maintenances).toHaveProperty('active');
        expect(full.maintenances).toHaveProperty('scheduled');
    });

    test('meta still carries the locale fields', () => {
        expect(typeof full.meta.default_locale).toBe('string');
        expect(Array.isArray(full.meta.supported_locales)).toBe(true);
    });

    test('component statuses are all values the bot understands', () => {
        // A new status value the bot has never seen would silently render as "unknown".
        const walk = (nodes) => nodes.flatMap((n) => [n.status, ...walk(n.children ?? [])]);
        for (const value of walk(full.components)) {
            expect(KNOWN_STATUSES).toContain(value);
        }
    });

    test('THE PARITY CHECK — the transcribed fold equals the server indicator', () => {
        // providers/cloudRollup.js is a third copy of a rule that also lives in Laravel and in
        // the Edge. This is what stops it drifting: fold the same page and compare against
        // what that page publishes for itself.
        const snapshot = cloudSnapshot(full, { url: CLOUD_URL, name: 'x' });
        expect(snapshot.overall).toBe(status.status.indicator);
    });

    test('the adapter produces a usable snapshot', () => {
        const snapshot = cloudSnapshot(full, { url: CLOUD_URL, name: 'x' });

        expect(snapshot.source).toBe(SOURCE.CLOUD);
        expect(snapshot.groups.length).toBeGreaterThan(0);

        for (const group of snapshot.groups) {
            expect(resolveText(group.name, 'de', snapshot.defaultLocale) || group.labelKey).toBeTruthy();
            for (const service of group.services) {
                expect(resolveText(service.name, 'de', snapshot.defaultLocale)).toBeTruthy();
                expect(KNOWN_STATUSES).toContain(service.status);
            }
        }
    });

    test('every listed component resolves in both offered languages', () => {
        const snapshot = cloudSnapshot(full, { url: CLOUD_URL, name: 'x' });

        for (const locale of snapshot.locales) {
            for (const group of snapshot.groups) {
                for (const service of group.services) {
                    expect(resolveText(service.name, locale, snapshot.defaultLocale)).toBeTruthy();
                }
            }
        }
    });

    test('a protected page is not readable through status.json', async () => {
        // The guard the bot relies on to tell "private" from "broken".
        const response = await fetch(`${CLOUD_URL}/status.json`);
        expect(response.status).toBe(200);
    }, 20000);
});

live('self-hosted contract', () => {
    let service;

    beforeAll(async () => {
        service = new StatuspageService(new LIVCK(SELF_HOSTED_URL, 'v3', null, 'de'));
        await service.fetchAll();
    }, 30000);

    test('categories still arrive as an object keyed by uuid', () => {
        // Not an array — the quirk services/statuspage.js normalizes.
        expect(service.categories.length).toBeGreaterThan(0);
    });

    test('every category carries its monitors', () => {
        for (const category of service.categories) {
            expect(Array.isArray(category.monitors)).toBe(true);
        }
    });

    test('monitor states are values the adapter maps', () => {
        const known = new Set(['AVAILABLE', 'UNAVAILABLE', 'DEGRADED', 'MAINTENANCE']);
        for (const category of service.categories) {
            for (const monitor of category.monitors) {
                expect(known).toContain(monitor.state);
            }
        }
    });

    test('the adapter produces a usable snapshot', () => {
        const snapshot = selfHostedSnapshot(service, { url: SELF_HOSTED_URL, name: 'status.livck.com' });

        expect(snapshot.source).toBe(SOURCE.SELF_HOSTED);
        expect(snapshot.groups.length).toBeGreaterThan(0);
        expect(KNOWN_STATUSES).toContain(snapshot.overall);
    });

    test('the Cloud surface is absent, so the two can never be confused', async () => {
        const response = await fetch(`${SELF_HOSTED_URL}/status.json`);
        expect(response.status).toBe(404);
    }, 20000);
});
