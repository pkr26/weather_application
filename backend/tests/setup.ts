// Must run before any module import: the pino logger reads LOG_LEVEL once at
// creation, so setting it here keeps the whole test suite silent.
process.env.LOG_LEVEL = 'silent'
