export default {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFiles: ['<rootDir>/__tests__/env.js'],
  // EVERY directory that runs in production.
  //
  // This was a list of six, and the five it omitted were not small: `providers/` is both
  // adapters and the detection layer, `dto/` is the model everything downstream reads, and
  // `discord/` is the entire command surface. A report that silently leaves out a third of the
  // code still prints a confident number at the bottom, and that number was being read as if
  // it meant something about all of it. The stale `utils/` comment below shows the same trap
  // caught once before.
  collectCoverageFrom: [
    'api/**/*.js',
    'config/**/*.js',
    'database/**/*.js',
    'discord/**/*.js',
    'dto/**/*.js',
    'handlers/**/*.js',
    'messages/**/*.js',
    'models/**/*.js',
    'providers/**/*.js',
    'services/**/*.js',
    // The directory is `util/`, not `utils/` — the old pattern matched nothing, so none of
    // the helpers ever appeared in a coverage report.
    'util/**/*.js',
    'server.js',
    // Migrations are verified by RUNNING them — up, down and re-run against a rebuilt legacy
    // schema in the end-to-end suites. Instrumenting them measures nothing that says anything.
    '!migrations/**',
    '!**/node_modules/**',
    '!**/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  testTimeout: 30000, // 30 seconds for API calls
  transform: {} // Disable transforms for ES modules
};
