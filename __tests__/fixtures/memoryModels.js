/**
 * The models the update loop and both handlers touch, held in memory.
 *
 * Just enough of Sequelize to run them: equality, `Op.in` and `Op.gte` in a where clause,
 * rows that can `update` and `destroy` themselves. A suite that needs the real queries uses
 * the e2e database instead; this one is for tests that are about timing and must run in
 * `npm test` without a database.
 *
 * Use with `jest.unstable_mockModule('../../models/index.js', () => ({ default: memory.models }))`.
 */

import { Op } from 'sequelize';

/**
 * `instance.update(values)` the way Sequelize does it: when no value actually changes there is
 * no UPDATE, and `updatedAt` stays where it was. A double that bumped it anyway hid the
 * heartbeat bug in util/messageSync.js (see `touch` there) from every test that used it.
 */
export const updateLikeSequelize = (row, values) => {
    const changed = Object.entries(values).some(([key, value]) => {
        const before = row[key];
        if (before instanceof Date && value instanceof Date) return before.getTime() !== value.getTime();
        return JSON.stringify(before) !== JSON.stringify(value);
    });
    if (!changed) return row;
    Object.assign(row, values, { updatedAt: new Date() });
    return row;
};

const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if (Op.in in expected) return expected[Op.in].includes(row[key]);
        if (Op.gte in expected) return row[key] >= expected[Op.gte];
        if (Op.lte in expected) return row[key] <= expected[Op.lte];
    }
    return row[key] === expected;
});

export const createMemoryModels = () => {
    const db = { statuspages: [], subscriptions: [], messages: [], customLinks: [], roleMentions: [] };
    let nextMessageId = 1;

    const withSubscriptions = (page) => page && {
        ...page,
        Subscriptions: db.subscriptions.filter((s) => s.statuspageId === page.id),
        save: async () => {},
        update: async (fields) => Object.assign(page, fields),
    };

    const messageRow = (fields) => {
        const row = {
            id: nextMessageId++,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...fields,
            async update(values) { return updateLikeSequelize(this, values); },
            async destroy() { db.messages = db.messages.filter((m) => m !== this); },
            async reload() { return this; },
        };
        db.messages.push(row);
        return row;
    };

    const models = {
        Statuspage: {
            // The loop's query filters on subscriptions and backoff; here, every page with a
            // subscription is due.
            findAll: async () => db.statuspages
                .filter((page) => db.subscriptions.some((s) => s.statuspageId === page.id))
                .map(withSubscriptions),
            findOne: async ({ where }) => withSubscriptions(db.statuspages.find((p) => matches(p, where))),
        },
        Subscription: {
            destroy: async ({ where }) => {
                const before = db.subscriptions.length;
                db.subscriptions = db.subscriptions.filter((s) => !matches(s, where));
                return before - db.subscriptions.length;
            },
        },
        Message: {
            findOne: async ({ where }) => db.messages.find((m) => matches(m, where)) ?? null,
            findAll: async ({ where }) => db.messages.filter((m) => matches(m, where)).sort((a, b) => a.id - b.id),
            create: async (fields) => messageRow(fields),
            update: async (values, { where }) => {
                const rows = db.messages.filter((m) => matches(m, where));
                for (const row of rows) Object.assign(row, values, { updatedAt: new Date() });
                return [rows.length];
            },
            destroy: async ({ where }) => {
                const before = db.messages.length;
                db.messages = db.messages.filter((m) => !matches(m, where));
                return before - db.messages.length;
            },
        },
        CustomLink: { findAll: async ({ where }) => db.customLinks.filter((l) => matches(l, where)) },
        RoleMention: { findAll: async ({ where }) => db.roleMentions.filter((r) => matches(r, where)) },
    };

    return {
        models,
        db,
        addPage: (fields) => {
            const page = { kind: 'CLOUD', externalId: 'fake', paused: false, ...fields };
            db.statuspages.push(page);
            return page;
        },
        subscribe: (fields) => {
            const subscription = {
                guildId: 'guild',
                layout: 'COMPACT',
                locale: 'de',
                apiToken: null,
                eventTypes: { STATUS: true, NEWS: false },
                createdAt: new Date('2020-01-01'),
                ...fields,
            };
            db.subscriptions.push(subscription);
            return subscription;
        },
        reset: () => {
            db.statuspages = [];
            db.subscriptions = [];
            db.messages = [];
            db.customLinks = [];
            db.roleMentions = [];
        },
    };
};

export default createMemoryModels;
