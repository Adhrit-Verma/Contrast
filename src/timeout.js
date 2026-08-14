/**
 * Give a promise a deadline. Used wherever the pipeline calls something with no
 * timeout of its own — Lighthouse, axe on a pathological page, a model that
 * never answers. The work is abandoned, not cancelled: we cannot un-call
 * Lighthouse, but we can stop waiting for it and move on.
 */
export function withTimeout(promise, ms, label = 'operation') {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s: ${label}`)), ms);
      timer.unref?.(); // never hold the process open on our account
    }),
  ]);
}
