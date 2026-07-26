module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@elgato/utils$': '<rootDir>/src/tests/__mocks__/@elgato/utils.ts',
  },
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverage: true,
};