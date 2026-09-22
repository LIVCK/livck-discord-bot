/**
 * The modal path, and the monkey-patch it stands on.
 *
 * `/livck subscribe` uses Type 18 (Label) components, which the pinned discord.js does not
 * support, so `scripts/patch-discordjs.js` rewrites two of its files at postinstall. Both are
 * load-bearing, and both used to fail in silence:
 *
 *   - Without the transformComponent patch a Label comes back with no customId at all. Every
 *     field is skipped, `url` and `channelId` stay null, and subscribe answers "error" —
 *     for everyone, for ever. Nobody can add a status page.
 *   - Without the ModalSubmitFields patch `interaction.fields.getTextInputValue` throws a
 *     TypeError, breaking the custom-link and API-token modals.
 *
 * The script warned and exited 0 when it could not find what to rewrite, and node_modules
 * restored from a build cache never runs postinstall at all. Either way `npm install` was
 * green and the bot came up missing its most important command.
 */

import { ModalSubmitInteraction } from 'discord.js';
import { checkModalSupport } from '../../util/discordPatch.js';

/** Exactly what Discord sends for the subscribe modal: snake_case, nested under `component`. */
const RAW_SUBMISSION = [
    { type: 18, component: { type: 4, custom_id: 'url', value: 'https://status.livck.com' } },
    { type: 18, component: { type: 8, custom_id: 'channel', values: ['1545819342770413718'] } },
    { type: 18, component: { type: 3, custom_id: 'events', values: ['all'] } },
    { type: 18, component: { type: 3, custom_id: 'locale', values: ['de'] } },
    { type: 18, component: { type: 3, custom_id: 'layout', values: ['COMPACT'] } },
];

/** The handler's own parsing, transcribed from discord/commands/livck.js. */
const parse = (components) => {
    const out = { url: null, channelId: null, events: 'ALL', locale: null, layout: 'DETAILED' };

    for (const component of components) {
        const actual = component.component || component;
        if (!actual?.customId) continue;

        if (actual.customId === 'url') out.url = actual.value;
        else if (actual.customId === 'channel') out.channelId = actual.values?.[0];
        else if (actual.customId === 'events') out.events = actual.values?.[0]?.toUpperCase() ?? 'ALL';
        else if (actual.customId === 'locale') out.locale = actual.values?.[0];
        else if (actual.customId === 'layout') out.layout = actual.values?.[0];
    }

    return out;
};

describe('the installed discord.js', () => {
    test('understands the modals this bot builds', () => {
        // The check the bot runs at startup. If this fails, the patch did not apply — and the
        // bot would otherwise have started and quietly refused every subscription.
        expect(checkModalSupport()).toEqual([]);
    });

    test('keeps a Label text input readable', () => {
        const out = ModalSubmitInteraction.transformComponent(RAW_SUBMISSION[0]);
        const inner = out.component ?? out;

        expect(inner.customId).toBe('url');
        expect(inner.value).toBe('https://status.livck.com');
    });

    test('keeps a Label select value readable', () => {
        // `values` is dropped entirely by the unpatched version, which is how the channel,
        // language and layout would all be lost while the URL still arrived.
        const out = ModalSubmitInteraction.transformComponent(RAW_SUBMISSION[1]);
        const inner = out.component ?? out;

        expect(inner.values).toEqual(['1545819342770413718']);
    });

    test('still handles an ordinary action row', () => {
        // The custom-link and API-token modals use plain rows; the patch must not break them.
        const out = ModalSubmitInteraction.transformComponent({
            type: 1,
            components: [{ type: 4, custom_id: 'label', value: 'Dokumentation' }],
        });

        expect(out.components[0].customId).toBe('label');
        expect(out.components[0].value).toBe('Dokumentation');
    });
});

describe('parsing a real submission', () => {
    test('every field arrives', () => {
        const parsed = parse(RAW_SUBMISSION.map((c) => ModalSubmitInteraction.transformComponent(c)));

        expect(parsed).toEqual({
            url: 'https://status.livck.com',
            channelId: '1545819342770413718',
            events: 'ALL',
            locale: 'de',
            layout: 'COMPACT',
        });
    });

    test('and without the patch it would arrive empty — which is the whole point', () => {
        // discord.js's original implementation, transcribed. A Label has no `components` and
        // no `custom_id` of its own, so it falls through to the leaf branch and yields
        // `customId: undefined` — the handler then skips every field and replies "error".
        const unpatched = (raw) => (raw.components
            ? { type: raw.type, components: raw.components.map(unpatched) }
            : { value: raw.value, type: raw.type, customId: raw.custom_id });

        const parsed = parse(RAW_SUBMISSION.map(unpatched));

        // Nothing was assigned, so both keep the values the handler starts them with — and
        // `if (!url || !channelId)` then answers commands.livck.subscribe.error.
        expect(parsed.url).toBeNull();
        expect(parsed.channelId).toBeNull();
    });
});
