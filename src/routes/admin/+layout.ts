// Server-rendered on purpose: admin pages show live account state, and the PWA's offline shell has no
// business holding them — see the `/admin` opt-out in src/service-worker/index.ts.
export const ssr = true;
export const prerender = false;
