/** Screen tests run in Jest with the Expo preset (native modules mocked); app code is unchanged. */
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  setupFiles: ['<rootDir>/test/setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/after-env.ts'],
  testTimeout: 20000,
};
