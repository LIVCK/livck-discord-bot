/**
 * Does this discord.js still understand the modals the bot builds?
 *
 * `/livck subscribe` uses Type 18 (Label) components. discord.js reads them itself from 14.23
 * on; before that `scripts/patch-discordjs.js` rewrote two of its files at postinstall, and
 * both rewrites failed silently whenever the source had moved or postinstall never ran.
 * The patch is gone, but the two failures it guarded against are the same for any
 * discord.js that does not read Labels:
 *
 *   ModalSubmitInteraction.transformComponent — a Label yields no customId at all, every
 *   field is skipped, and subscribe answers "error" for ever. No subscription can be created
 *   by anyone.
 *
 *   ModalSubmitFields — `interaction.fields.getTextInputValue` cannot find the field, which
 *   breaks adding or editing a custom link and changing the API token.
 *
 * Neither shows at startup; the bot comes up healthy and missing the only way to add a status
 * page. So this asks the library at boot, with exactly the shape Discord sends, and refuses
 * to start on one that gets it wrong — a downgrade, a lock file out of step, a cached install.
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
    console.error('It needs discord.js 14.23 or later (package-lock.json has 14.28.1); run `npm ci`.');

    // Unconditionally, like every other startup gate. It was skipped under NODE_ENV=test,
    // which made the one thing worth asserting about a gate — that it actually stops the boot
    // — impossible to assert. Nothing in the suite reaches this: it is called from
    // initializeBot, which no test invokes.
    process.exit(1);
};

export default { checkModalSupport, requireModalSupport };
