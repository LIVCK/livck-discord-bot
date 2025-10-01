import translation from '../../util/Translation.js';

describe('Translation System', () => {
  let originalConsoleWarn;
  let originalConsoleLog;

  beforeAll(() => {
    // Suppress console.warn and console.log for all tests
    originalConsoleWarn = console.warn;
    originalConsoleLog = console.log;
    console.warn = () => {};
    console.log = () => {};
  });

  afterAll(() => {
    // Restore original console methods
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;
  });

  beforeEach(() => {
    // Reset to English before each test
    translation.setLocale('en');
  });

  describe('Locale Management', () => {
    test('should default to English (en)', () => {
      expect(translation.currentLocale).toBe('en');
      expect(translation.fallbackLocale).toBe('en');
    });

    test('should load available locales', () => {
      const locales = translation.getAvailableLocales();
      expect(locales).toContain('de');
      expect(locales).toContain('en');
      expect(Array.isArray(locales)).toBe(true);
    });

    test('should switch locale', () => {
      translation.setLocale('en');
      expect(translation.currentLocale).toBe('en');

      translation.setLocale('de');
      expect(translation.currentLocale).toBe('de');
    });

    test('should fallback to default on invalid locale', () => {
      translation.setLocale('xx'); // Not available
      expect(translation.currentLocale).toBe('en'); // Falls back to English
    });
  });

  describe('Translation Keys', () => {
    test('should translate simple keys (German)', () => {
      translation.setLocale('de');
      const response = translation.trans('commands.ping.response');

      expect(response).toBeDefined();
      expect(typeof response).toBe('string');
      expect(response.length).toBeGreaterThan(0);
    });

    test('should translate simple keys (English)', () => {
      translation.setLocale('en');
      const response = translation.trans('commands.ping.response');

      expect(response).toBeDefined();
      expect(typeof response).toBe('string');
      expect(response.length).toBeGreaterThan(0);
    });

    test('should return key if translation missing', () => {
      const result = translation.trans('non.existent.key');
      expect(result).toBe('non.existent.key');
    });

    test('should check if key exists', () => {
      expect(translation.has('commands.ping.response')).toBe(true);
      expect(translation.has('non.existent.key')).toBe(false);
    });
  });

  describe('Placeholder Replacement', () => {
    test('should replace single placeholder', () => {
      const text = 'Hello :name!';
      const result = translation.replacePlaceholders(text, { name: 'World' });

      expect(result).toBe('Hello World!');
    });

    test('should replace multiple placeholders', () => {
      const text = ':greeting :name, you have :count messages';
      const result = translation.replacePlaceholders(text, {
        greeting: 'Hello',
        name: 'Alice',
        count: 5
      });

      expect(result).toBe('Hello Alice, you have 5 messages');
    });

    test('should leave unreplaced placeholders as-is', () => {
      const text = 'Hello :name, :age years old';
      const result = translation.replacePlaceholders(text, { name: 'Bob' });

      expect(result).toBe('Hello Bob, :age years old');
    });

    test('should handle empty replacements', () => {
      const text = 'Hello :name';
      const result = translation.replacePlaceholders(text, {});

      expect(result).toBe('Hello :name');
    });

    test('should handle non-string input', () => {
      expect(translation.replacePlaceholders(null, {})).toBeNull();
      expect(translation.replacePlaceholders(undefined, {})).toBeUndefined();
      expect(translation.replacePlaceholders(123, {})).toBe(123);
    });
  });

  describe('Pluralization', () => {
    test('should choose zero form', () => {
      const text = 'no items|one item|:count items';
      const result = translation.choosePlural(text, 0);

      expect(result).toBe('no items');
    });

    test('should choose singular form', () => {
      const text = 'no items|one item|:count items';
      const result = translation.choosePlural(text, 1);

      expect(result).toBe('one item');
    });

    test('should choose plural form', () => {
      const text = 'no items|one item|:count items';
      const result = translation.choosePlural(text, 5);

      expect(result).toBe(':count items');
    });

    test('should handle non-plural text', () => {
      const text = 'simple text';
      const result = translation.choosePlural(text, 5);

      expect(result).toBe('simple text');
    });
  });

  describe('Full Translation (trans)', () => {
    beforeEach(() => {
      translation.setLocale('de');
    });

    test('should translate with replacements', () => {
      // Real key from de.json
      const result = translation.trans('commands.livck.subscribe.success', {
        url: 'status.livck.com',
        channelId: '123456',
        flag: '🇩🇪',
        locale: 'DE'
      });

      expect(result).toContain('status.livck.com');
      expect(result).toContain('123456');
      expect(result).toBeDefined();
    });

    test('should handle pluralization with count', () => {
      // Assuming there's a plural key in translations
      const result = translation.trans('test.items', {}, 5);

      expect(result).toBeDefined();
    });
  });

  describe('Localization for Discord', () => {
    test('should create localization map', () => {
      const localizations = translation.localize('commands.ping.description');

      expect(localizations).toBeDefined();
      expect(typeof localizations).toBe('object');
      expect(localizations.de).toBeDefined();
      expect(localizations.en).toBeDefined();
    });

    test('should create localization map excluding default locale', () => {
      const localizations = translation.localizeExcept('commands.ping.description', 'en');

      expect(localizations).toBeDefined();
      expect(localizations.en).toBeUndefined();
      expect(localizations.de).toBeDefined();
    });

    test('should handle replacements in localization', () => {
      const localizations = translation.localize('commands.ping.description', {
        test: 'value'
      });

      Object.values(localizations).forEach(text => {
        expect(typeof text).toBe('string');
      });
    });
  });

  describe('Critical Translation Keys Existence', () => {
    const criticalKeys = [
      'commands.livck.subscribe.success',
      'commands.livck.subscribe.error',
      'commands.livck.subscribe.invalid_livck_url',
      'commands.livck.unsubscribe.success',
      'commands.livck.list.no_subscriptions',
      'commands.livck.edit.editing',
      'commands.livck.custom_links.add_button'
    ];

    test.each(criticalKeys)('should have %s in both DE and EN', (key) => {
      ['de', 'en'].forEach(locale => {
        translation.setLocale(locale);
        const result = translation.trans(key);

        expect(result).toBeDefined();
        expect(typeof result).toBe('string');
        expect(result).not.toBe(key); // Should not return the key itself
        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Layout Translations', () => {
    const layouts = ['detailed', 'compact', 'overview', 'minimal'];

    test.each(layouts)('should have %s layout in both languages', (layout) => {
      ['de', 'en'].forEach(locale => {
        translation.setLocale(locale);

        const name = translation.trans(`commands.livck.layouts.${layout}.name`);
        const description = translation.trans(`commands.livck.layouts.${layout}.description`);

        expect(name).toBeDefined();
        expect(description).toBeDefined();
        expect(name).not.toBe(`commands.livck.layouts.${layout}.name`);
        expect(description).not.toBe(`commands.livck.layouts.${layout}.description`);
      });
    });
  });

  describe('Performance', () => {
    test('should handle many translations quickly', () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        translation.trans('commands.ping.response');
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100); // Should be very fast
    });
  });
});
