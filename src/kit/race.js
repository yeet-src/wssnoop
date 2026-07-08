/* race — resolve a promise, or reject with a timeout if it takes too long. Pure,
 * dependency-free. Kit-generic: an extraction candidate for a shared yeet module.
 *
 * The probes use it to bound a graph query: a pathological query can wedge the
 * daemon (see README's graph caveat), so every poll races a short deadline. */

export const race = (promise, ms, label = "timeout") =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
