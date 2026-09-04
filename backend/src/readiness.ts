/**
 * Process-level readiness, shared between the server entrypoint and the
 * health route. Flips true on SIGTERM/SIGINT so a draining instance answers
 * health checks with 503 — load balancers stop routing new work to a process
 * that is about to hard-exit, instead of seeing green until it dies.
 */
// Stryker disable ObjectLiteral: replacing the initialiser with {} yields value===undefined, which is falsy exactly like false — every consumer only branches on truthiness
export const draining = { value: false }
// Stryker restore ObjectLiteral
