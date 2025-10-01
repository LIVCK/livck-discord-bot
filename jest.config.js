export default {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFiles: ['<rootDir>/__tests__/env.js'],
  collectCoverageFrom: [
    'api/**/*.js',
    'services/**/*.js',
    'utils/**/*.js',
    'handlers/**/*.js',
    '!**/node_modules/**',
    '!**/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  testTimeout: 30000, // 30 seconds for API calls
  transform: {} // Disable transforms for ES modules
};
