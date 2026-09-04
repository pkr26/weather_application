/**
 * Process-level readiness, shared between the server entrypoint and the
 * health route. Flips true on SIGTERM/SIGINT so a draining instance answers
 * health checks with 503 — load balancers stop routing new work to a process
 * that is about to hard-exit, instead of seeing green until it dies.
 */
export const draining = { value: false }
