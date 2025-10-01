import { normalizeUrl, domainFromUrl, truncate } from '../../util/String.js';

describe('String Utilities', () => {
  describe('normalizeUrl', () => {
    test('should add https:// if protocol missing', () => {
      expect(normalizeUrl('status.livck.com')).toBe('https://status.livck.com');
      expect(normalizeUrl('example.com')).toBe('https://example.com');
    });

    test('should preserve existing https://', () => {
      expect(normalizeUrl('https://status.livck.com')).toBe('https://status.livck.com');
    });

    test('should preserve http:// protocol', () => {
      // normalizeUrl preserves the protocol, doesn't convert http to https
      expect(normalizeUrl('http://status.livck.com')).toBe('http://status.livck.com');
    });

    test('should remove single trailing slash', () => {
      expect(normalizeUrl('https://status.livck.com/')).toBe('https://status.livck.com');
      // Multiple slashes are kept (only removes if ends with single slash)
      expect(normalizeUrl('https://status.livck.com///')).toBe('https://status.livck.com//');
    });

    test('should handle paths correctly', () => {
      expect(normalizeUrl('https://status.livck.com/api/status')).toBe('https://status.livck.com/api/status');
      expect(normalizeUrl('status.livck.com/api')).toBe('https://status.livck.com/api');
    });

    test('should ignore path when ignorePath=true', () => {
      expect(normalizeUrl('https://status.livck.com/api/status', true)).toBe('https://status.livck.com');
      expect(normalizeUrl('status.livck.com/path/to/page', true)).toBe('https://status.livck.com');
    });

    test('should lowercase the hostname and path', () => {
      // lowercase protocol check means 'https://' works
      expect(normalizeUrl('https://STATUS.LIVCK.COM')).toBe('https://status.livck.com');
      expect(normalizeUrl('Status.LIVCK.com/API')).toBe('https://status.livck.com/api');
    });

    test('should handle null/undefined gracefully', () => {
      expect(normalizeUrl(null)).toBeNull();
      expect(normalizeUrl(undefined)).toBeNull();
      expect(normalizeUrl('')).toBeNull();
    });

    test('should throw on invalid URLs', () => {
      // 'not a url' becomes 'https://not a url' which is invalid (spaces)
      expect(() => normalizeUrl('not a url')).toThrow();
    });

    test('should handle subdomains correctly', () => {
      expect(normalizeUrl('demo.status.livck.com')).toBe('https://demo.status.livck.com');
    });

    test('should not include ports in normalized URL', () => {
      // normalizeUrl only uses hostname, not hostname:port
      const result = normalizeUrl('https://status.livck.com:8080');
      expect(result).toBe('https://status.livck.com');
    });

    test('should handle query params', () => {
      // normalizeUrl only keeps protocol + hostname + pathname, no query params
      const normalized = normalizeUrl('https://status.livck.com?test=1');
      expect(normalized).toBe('https://status.livck.com');
    });
  });

  describe('domainFromUrl', () => {
    test('should extract hostname from full URL', () => {
      expect(domainFromUrl('https://status.livck.com')).toBe('status.livck.com');
      expect(domainFromUrl('https://example.com/path')).toBe('example.com');
    });

    test('should handle URLs with ports (hostname only)', () => {
      // hostname property doesn't include port
      expect(domainFromUrl('https://status.livck.com:8080')).toBe('status.livck.com');
    });

    test('should handle subdomains', () => {
      expect(domainFromUrl('https://demo.status.livck.com')).toBe('demo.status.livck.com');
    });

    test('should throw on invalid URLs', () => {
      expect(() => domainFromUrl('not a url')).toThrow('Wrong URL');
      expect(() => domainFromUrl('')).toThrow('Wrong URL');
    });

    test('should handle http protocol', () => {
      expect(domainFromUrl('http://example.com')).toBe('example.com');
    });

    test('should require protocol for valid parsing', () => {
      // URLs without protocol should throw
      expect(() => domainFromUrl('status.livck.com')).toThrow('Wrong URL');
    });
  });

  describe('truncate', () => {
    test('should truncate long text with default length (500)', () => {
      const longText = 'a'.repeat(600);
      const result = truncate(longText);

      expect(result.length).toBe(503); // 500 + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    test('should not truncate short text', () => {
      const shortText = 'This is a short text';
      expect(truncate(shortText)).toBe(shortText);
    });

    test('should handle custom length', () => {
      const text = 'a'.repeat(100);
      const result = truncate(text, 50);

      expect(result.length).toBe(53); // 50 + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    test('should handle exact length match', () => {
      const text = 'a'.repeat(500);
      const result = truncate(text, 500);

      expect(result).toBe(text);
      expect(result.endsWith('...')).toBe(false);
    });

    test('should handle empty string', () => {
      expect(truncate('')).toBe('');
    });

    test('should handle single character', () => {
      expect(truncate('a')).toBe('a');
    });

    test('should preserve content integrity', () => {
      const text = 'This is important content that needs to be preserved';
      const result = truncate(text, 20);

      expect(result.startsWith('This is important co')).toBe(true);
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('Real-world scenarios', () => {
    test('should normalize various LIVCK statuspage URLs correctly', () => {
      const urls = [
        'status.livck.com',
        'https://status.livck.com/',
        'https://STATUS.LIVCK.COM', // lowercase 'https://' is recognized
        'https://status.livck.com/api/status'
      ];

      // All should normalize to the same base URL when ignorePath=true
      urls.forEach(url => {
        const normalized = normalizeUrl(url, true);
        expect(normalized).toBe('https://status.livck.com');
      });
    });

    test('should handle user input variations', () => {
      expect(normalizeUrl('status.livck.com')).toBe('https://status.livck.com');
      expect(normalizeUrl('https://status.livck.com'.trim())).toBe('https://status.livck.com');
      // Lowercase protocol only
      expect(normalizeUrl('https://STATUS.LIVCK.COM/'.trim())).toBe('https://status.livck.com');
    });
  });
});
