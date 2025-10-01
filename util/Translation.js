import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Translation {
    constructor() {
        this.translations = {};
        this.currentLocale = 'de';
        this.fallbackLocale = 'de';
        this.loadTranslations();
    }

    /**
     * Load all translation files from lang/ directory
     */
    loadTranslations() {
        const langDir = path.resolve(__dirname, '../lang');

        if (!fs.existsSync(langDir)) {
            console.warn('[Translation] lang/ directory not found, creating it...');
            fs.mkdirSync(langDir, { recursive: true });
            return;
        }

        const files = fs.readdirSync(langDir).filter(f => f.endsWith('.json'));

        files.forEach(file => {
            const locale = path.basename(file, '.json');
            try {
                const content = fs.readFileSync(path.join(langDir, file), 'utf-8');
                this.translations[locale] = JSON.parse(content);
                // Only log in non-test environments
                if (process.env.NODE_ENV !== 'test') {
                    console.log(`[Translation] Loaded locale: ${locale}`);
                }
            } catch (error) {
                console.error(`[Translation] Error loading ${file}:`, error.message);
            }
        });
    }

    /**
     * Set the current locale
     * @param {string} locale - Locale code (e.g., 'de', 'en')
     */
    setLocale(locale) {
        if (this.translations[locale]) {
            this.currentLocale = locale;
        } else {
            console.warn(`[Translation] Locale '${locale}' not found, using fallback '${this.fallbackLocale}'`);
            this.currentLocale = this.fallbackLocale;
        }
    }

    /**
     * Get nested translation value by dot notation
     * @param {string} key - Translation key (e.g., 'commands.ping.response')
     * @param {string} locale - Locale to use (defaults to currentLocale)
     * @returns {string|null} - Translation string or null if not found
     */
    get(key, locale = null) {
        const targetLocale = locale || this.currentLocale;
        const keys = key.split('.');
        let value = this.translations[targetLocale];

        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                // Fallback to fallbackLocale if key not found
                if (targetLocale !== this.fallbackLocale) {
                    return this.get(key, this.fallbackLocale);
                }
                return null;
            }
        }

        return value;
    }

    /**
     * Replace placeholders in text with actual values
     * @param {string} text - Text with placeholders like :name, :count
     * @param {object} replacements - Object with replacement values
     * @returns {string} - Text with placeholders replaced
     */
    replacePlaceholders(text, replacements = {}) {
        if (typeof text !== 'string') return text;

        return text.replace(/:(\w+)/g, (match, key) => {
            return replacements[key] !== undefined ? replacements[key] : match;
        });
    }

    /**
     * Choose correct plural form based on count
     * @param {string} text - Text with pipe separators (e.g., "no items|one item|:count items")
     * @param {number} count - Count to determine plural form
     * @returns {string} - Selected plural form
     */
    choosePlural(text, count) {
        if (typeof text !== 'string' || !text.includes('|')) {
            return text;
        }

        const parts = text.split('|').map(part => part.trim());

        // Format: "zero form|singular form|plural form"
        // parts[0] = count === 0
        // parts[1] = count === 1
        // parts[2] = count > 1

        if (count === 0 && parts[0]) {
            return parts[0];
        } else if (count === 1 && parts[1]) {
            return parts[1];
        } else if (count > 1 && parts[2]) {
            return parts[2];
        }

        // Fallback to last part if count doesn't match
        return parts[parts.length - 1] || text;
    }

    /**
     * Main translation function
     * @param {string} key - Translation key (e.g., 'messages.status.title')
     * @param {object} replacements - Placeholder replacements (e.g., { name: 'Server', count: 5 })
     * @param {number|null} count - Count for pluralization (if null, no pluralization)
     * @param {string|null} locale - Override locale (defaults to currentLocale)
     * @returns {string} - Translated and processed string
     */
    trans(key, replacements = {}, count = null, locale = null) {
        // Get translation
        let text = this.get(key, locale);

        // If not found, return key as fallback
        if (text === null) {
            console.warn(`[Translation] Missing key: ${key} (locale: ${locale || this.currentLocale})`);
            return key;
        }

        // Handle pluralization if count is provided
        if (count !== null && typeof text === 'string' && text.includes('|')) {
            text = this.choosePlural(text, count);
            // Auto-add count to replacements
            replacements.count = count;
        }

        // Replace placeholders
        text = this.replacePlaceholders(text, replacements);

        return text;
    }

    /**
     * Check if translation key exists
     * @param {string} key - Translation key
     * @param {string|null} locale - Locale to check (defaults to currentLocale)
     * @returns {boolean} - True if key exists
     */
    has(key, locale = null) {
        return this.get(key, locale) !== null;
    }

    /**
     * Get all available locales
     * @returns {string[]} - Array of locale codes
     */
    getAvailableLocales() {
        return Object.keys(this.translations);
    }

    /**
     * Reload translations from disk (useful for development)
     */
    reload() {
        this.translations = {};
        this.loadTranslations();
    }

    /**
     * Get localization map for Discord commands
     * Creates an object with locale codes as keys and translated strings as values
     * @param {string} key - Translation key (e.g., 'commands.livck.description')
     * @param {object} replacements - Optional placeholder replacements
     * @returns {object} - Object like { 'de': 'German text', 'en': 'English text' }
     *
     * @example
     * // lang/de.json: { "commands": { "ping": { "description": "Antwortet mit Pong!" } } }
     * // lang/en.json: { "commands": { "ping": { "description": "Replies with Pong!" } } }
     *
     * localize('commands.ping.description')
     * // Returns: { 'de': 'Antwortet mit Pong!', 'en': 'Replies with Pong!' }
     */
    localize(key, replacements = {}) {
        const localizations = {};
        const availableLocales = this.getAvailableLocales();

        for (const locale of availableLocales) {
            const text = this.get(key, locale);

            if (text !== null && text !== key) {
                // Replace placeholders if provided
                localizations[locale] = this.replacePlaceholders(text, replacements);
            }
        }

        return localizations;
    }

    /**
     * Get localization map excluding the default locale
     * Useful for Discord which expects localizations without the default language
     * @param {string} key - Translation key
     * @param {string} defaultLocale - Default locale to exclude (defaults to 'en-US')
     * @param {object} replacements - Optional placeholder replacements
     * @returns {object} - Localization object without default locale
     *
     * @example
     * localizeExcept('commands.ping.description', 'en-US')
     * // Returns: { 'de': 'Antwortet mit Pong!' }  (without 'en')
     */
    localizeExcept(key, defaultLocale = 'en-US', replacements = {}) {
        const localizations = this.localize(key, replacements);

        // Discord uses locale codes like 'en-US', 'en-GB', but we store just 'en'
        // So we need to check both 'en-US' format and just 'en'
        const shortLocale = defaultLocale.split('-')[0];

        // Remove default locale
        delete localizations[defaultLocale];
        delete localizations[shortLocale];

        return localizations;
    }
}

// Export singleton instance
const translation = new Translation();
export default translation;

// Named export for trans() shorthand
export const trans = (key, replacements, count, locale) =>
    translation.trans(key, replacements, count, locale);