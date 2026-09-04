export default {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFiles: ['<rootDir>/__tests__/env.js'],
  collectCoverageFrom: [
    'api/**/*.js',
    'services/**/*.js',
    // The directory is `util/`, not `utils/` — the old pattern matched nothing, so none of
    // the helpers ever appeared in a coverage report.
    'util/**/*.js',
    'handlers/**/*.js',
    'messages/**/*.js',
    'config/**/*.js',
    '!**/node_modules/**',
    '!**/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  testTimeout: 30000, // 30 seconds for API calls
  transform: {} // Disable transforms for ES modules
};
