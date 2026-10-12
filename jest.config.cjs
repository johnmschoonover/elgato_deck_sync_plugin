module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
      // Type errors are the typecheck step's job (`npm run typecheck` covers src/tests
      // and runs before the tests in CI); keeping diagnostics off here keeps jest fast.
      diagnostics: false,
    }],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/plugin.ts', '!src/tests/**'],
  coverageThreshold: {
    global: { statements: 90, branches: 85, functions: 90, lines: 90 },
    './src/syncEngine.ts': { statements: 95, branches: 90, functions: 95, lines: 95 },
  },
};
