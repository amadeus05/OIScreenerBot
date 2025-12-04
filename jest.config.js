module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    moduleNameMapper: {
      '^@domain/(.*)$': '<rootDir>/src/domain/$1',
      // добавь другие алиасы если используешь
    },
  };