/**
 * jsdom, loaded when first constructed.
 *
 * jsdom is NOT bundled: it reads its default stylesheet from disk at load time, so it ships as a real
 * node_modules folder next to the bundle (see scripts/android/build-backend.mjs). If it is missing or
 * the embedded Node refuses it, only the features that need a DOM (the YouTube PO-token attestation and
 * Genius lyrics) fail — and both already treat failure as "carry on without".
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export class JSDOM {
  constructor(html?: string, options?: any) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const real = require("jsdom-real");
    return new real.JSDOM(html, options);
  }
}
