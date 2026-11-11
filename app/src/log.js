/** Minimal prefixed logger so container logs stay readable. */
export function createLogger(scope) {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => console.log(new Date().toISOString(), prefix, ...args),
    warn: (...args) => console.warn(new Date().toISOString(), prefix, ...args),
    error: (...args) => console.error(new Date().toISOString(), prefix, ...args),
  };
}
