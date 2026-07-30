/**
 * TEST-ONLY upload stub switch.
 *
 * Its own module, and deliberately not part of lib/cloudinary: both the upload
 * adapter and the URL SIGNER need it, and several suites mock lib/cloudinary
 * wholesale. Exporting it from there meant every one of those mocks had to
 * grow a new key or the signer blew up with "No 'uploadStubEnabled' export is
 * defined on the mock" — which is how this file came to exist. One definition,
 * no mock surface.
 *
 * WHY A STUB AT ALL: the CI browser suite uploads for real — resetState pushes
 * a POD to close out a stop, the exception flow posts evidence — and a runner
 * has no Cloudinary credentials. Real ones would write junk into the live asset
 * account on every push.
 *
 * Enabling it is deliberately hard by accident and IMPOSSIBLE in production:
 * the flag must be exactly "true" AND NODE_ENV must not be "production". If
 * faked uploads ever reached production, PODs would silently stop being stored,
 * and a POD is the evidence a payment dispute turns on — the failure would stay
 * invisible until someone went looking for a photo that never existed.
 */
export function uploadStubEnabled(): boolean {
  return process.env.E2E_STUB_UPLOADS === "true" && process.env.NODE_ENV !== "production";
}
