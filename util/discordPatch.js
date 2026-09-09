/**
 * Does this discord.js still understand the modals the bot builds?
 *
 * `/livck subscribe` uses Type 18 (Label) components, which the pinned discord.js does not
 * support, so `scripts/patch-discordjs.js` rewrites two of its files at postinstall. Both are
 * load-bearing and both fail silently:
 *
 *   ModalSubmitInteraction.transformComponent — without it a Label yields no customId at all,
 *   every field is skipped, and subscribe answers "error" for ever. No subscription can be
 *   created by anyone.
 *
 *   ModalSubmitFields — without it `interaction.fields.getTextInputValue` throws a TypeError,
 *   which breaks adding or editing a custom link and changing the API token.
 *
 * The patch script warns and exits 0 when it cannot find what to rewrite, and node_modules
 * restored from a build cache never runs postinstall at all. Either way the bot starts, looks
 * healthy, and is missing the only way to add a status page.
 *
 * So this asks the library a question instead of grepping its source: given exactly the shape
 * Discord sends, does it come back readable? A rewritten patch, a different discord.js, a
 * cached install — all of them answer honestly.
 */

import { ModalSubmitInteraction, ModalSubmitFields } from 'discord.js';

/** What Discord actually sends for a Label wrapping a text input. */
const LABEL_WITH_TEXT = { type: 18, component: { type: 4, custom_id: 'probe', value: 'value' } };
/** …and for a Label wrapping a select. */
const LABEL_WITH_SELECT = { type: 18, component: { type: 3, custom_id: 'pick', values: ['one'] } };

/**
 * @returns {string[]} what is broken, empty when the modals will work
 */
export const checkModalSupport = () => {
    const problems = [];

    try {
        const text = ModalSubmitInteraction.transformComponent(LABEL_WITH_TEXT);
        const inner = text?.component ?? text;
        if (inner?.customId !== 'probe' || inner?.value !== 'value') {
            problems.push('transformComponent drops Type 18 labels — /livck subscribe cannot read its own modal');
        }

        const select = ModalSubmitInteraction.transformComponent(LABEL_WITH_SELECT);
        const picked = select?.component ?? select;
        if (picked?.values?.[0] !== 'one') {
            problems.push('transformComponent drops select values — channel, language and layout would be lost');
        }
    } catch (error) {
        problems.push(`transformComponent threw: ${error.message}`);
    }

    try {
        const fields = new ModalSubmitFields([
            { type: 18, component: { type: 4, customId: 'label', value: 'x' } },
        ]);
        if (fields.getTextInputValue('label') !== 'x') {
            problems.push('ModalSubmitFields cannot read a Type 18 label — custom links and the API token modal break');
        }
    } catch (error) {
        problems.push(`ModalSubmitFields threw: ${error.message}`);
    }

    return problems;
};

/**
 * Refuse to start rather than come up missing the only way to add a status page.
 */
export const requireModalSupport = () => {
    const problems = checkModalSupport();
    if (problems.length === 0) return;

    console.error('discord.js is missing the Type 18 modal support this bot needs:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Run `node scripts/patch-discordjs.js` (npm install does it automatically).');

    if (process.env.NODE_ENV !== 'test') process.exit(1);
};

export default { checkModalSupport, requireModalSupport };
