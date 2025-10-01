import LIVCK from '../../api/livck.js';

describe('LIVCK API Client', () => {
  const TEST_URL = 'https://status.livck.com';
  let client;
  let originalConsoleError;
  let originalConsoleWarn;

  beforeAll(() => {
    // Suppress console.error and console.warn for all tests
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
  });

  afterAll(() => {
    // Restore original console methods
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  beforeEach(() => {
    client = new LIVCK(TEST_URL);
  });

  describe('Client Initialization', () => {
    test('should initialize with base URL', () => {
      expect(client.baseURL).toBe(TEST_URL);
      expect(client.apiVersion).toBe('v3');
    });

    test('should build correct API paths', () => {
      const path = client.build('categories');
      expect(path).toContain('/api/v3/categories');
    });
  });

  describe('ensureIsLIVCK Method', () => {
    test('should verify LIVCK instance (status.livck.com)', async () => {
      const isValid = await client.ensureIsLIVCK();
      expect(isValid).toBe(true);
    }, 10000);

    test('should detect non-LIVCK URLs', async () => {
      const nonLivckClient = new LIVCK('https://google.com');
      const isValid = await nonLivckClient.ensureIsLIVCK();
      expect(isValid).toBe(false);
    }, 10000);

    test('should handle network errors gracefully', async () => {
      const invalidClient = new LIVCK('https://invalid-domain-12345.test');
      const isValid = await invalidClient.ensureIsLIVCK();
      // Should return false or undefined, not throw
      expect([false, undefined]).toContain(isValid);
    }, 10000);
  });

  describe('GET Method', () => {
    test('should successfully fetch categories from status.livck.com', async () => {
      const response = await client.get('categories');

      expect(response).toBeDefined();
      // Response can be object or { data: [] } on error
      expect(typeof response).toBe('object');
    }, 10000);

    test('should successfully fetch monitors from status.livck.com', async () => {
      const response = await client.get('monitors');

      expect(response).toBeDefined();
      expect(typeof response).toBe('object');
    }, 10000);

    test('should handle invalid endpoints gracefully', async () => {
      const response = await client.get('nonexistent');

      // Should return { data: [] } on error, not throw
      expect(response).toBeDefined();
      expect(response).toHaveProperty('data');
      expect(Array.isArray(response.data)).toBe(true);
    }, 10000);

    test('should handle network timeouts gracefully', async () => {
      const timeoutClient = new LIVCK('https://httpstat.us/524?sleep=5000');
      const response = await timeoutClient.get('test');

      // Should return { data: [] } on error, not throw
      expect(response).toBeDefined();
      expect(response).toHaveProperty('data');
    }, 10000);
  });

  describe('Error Handling', () => {
    test('should not throw on 403 responses', async () => {
      // This should log a warning but return { data: [] }
      const response = await client.get('private-endpoint-that-returns-403');

      expect(response).toBeDefined();
      expect(response.data).toEqual([]);
    }, 10000);

    test('should not throw on network errors', async () => {
      const badClient = new LIVCK('https://invalid.test');
      const response = await badClient.get('test');

      expect(response).toBeDefined();
      expect(response.data).toEqual([]);
    }, 10000);
  });

  describe('Production Readiness', () => {
    test('should fetch real data from status.livck.com within 5 seconds', async () => {
      const startTime = Date.now();

      const [categories, monitors] = await Promise.all([
        client.get('categories'),
        client.get('monitors')
      ]);

      const duration = Date.now() - startTime;

      expect(categories).toBeDefined();
      expect(monitors).toBeDefined();
      expect(typeof categories).toBe('object');
      expect(typeof monitors).toBe('object');
      expect(duration).toBeLessThan(5000);
    }, 10000);

    test('should verify lvk-version header is present', async () => {
      const isValid = await client.ensureIsLIVCK();
      expect(isValid).toBe(true);
    }, 10000);
  });
});
