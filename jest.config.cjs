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
  collectCoverageFrom: ['src/**/*.ts', '!src/tests/**'],
  coverageThreshold: {
    global: { statements: 98, branches: 97, functions: 98, lines: 98 },
    './src/syncEngine.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
};
