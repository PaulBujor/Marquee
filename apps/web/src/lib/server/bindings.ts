import { env as cloudflare_env, waitUntil as cloudflare_waitUntil } from 'cloudflare:workers';

// `cloudflare:workers` types `env` from the bindings wrangler generates, which omits `wrangler secret` values.
export const env = cloudflare_env as unknown as Env;
export const waitUntil = cloudflare_waitUntil as (promise: Promise<unknown>) => void;
