/**
 * Pairing: the one-time exchange that turns a handle into a working bridge.
 *
 * Two credentials are pasted in — a Marquee API token and the user's Stremio `authKey` — and
 * each is checked against the service that issued it before anything is stored. No Stremio
 * password ever reaches this Worker: the `authKey` is what Stremio itself authorises with.
 */
import type { BridgeRecord } from './bridges';

export interface PairingInput {
	marqueeToken: string;
	stremioAuthKey: string;
}

export type PairingResult =
	| { ok: true; record: BridgeRecord }
	/** `field` says which box to put the message under; the message is safe to show verbatim. */
	| { ok: false; field: 'marqueeToken' | 'stremioAuthKey'; message: string };

export async function pair(env: Env, input: PairingInput): Promise<PairingResult> {
	const marqueeError = await checkMarquee(env, input.marqueeToken);
	if (marqueeError) return { ok: false, field: 'marqueeToken', message: marqueeError };

	const stremioError = await checkStremio(env, input.stremioAuthKey);
	if (stremioError) return { ok: false, field: 'stremioAuthKey', message: stremioError };

	return {
		ok: true,
		record: {
			marqueeToken: input.marqueeToken,
			stremioAuthKey: input.stremioAuthKey,
			createdAt: new Date().toISOString()
		}
	};
}

/** One paged read is enough: it answers 401 for a bad token and 200 for a good one. */
async function checkMarquee(env: Env, token: string): Promise<string | null> {
	let response: Response;
	try {
		response = await fetch(`${env.MARQUEE_API_URL}/api/v1/library?limit=1`, {
			headers: { authorization: `Bearer ${token}` }
		});
	} catch {
		return 'Could not reach Marquee. Try again in a moment.';
	}

	if (response.ok) return null;
	if (response.status === 401) return 'Marquee did not accept that token.';
	return `Marquee answered ${response.status}. Try again in a moment.`;
}

/**
 * `datastoreMeta` is the cheapest call that proves the key: it reads collection metadata without
 * returning the library. Stremio answers HTTP 200 with an `error` envelope, never a status code.
 */
async function checkStremio(env: Env, authKey: string): Promise<string | null> {
	let body: { result?: unknown; error?: { code?: number; message?: string } };
	try {
		const response = await fetch(`${env.STREMIO_API_URL}/datastoreMeta`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ authKey, collection: 'libraryItem' })
		});
		body = await response.json();
	} catch {
		return 'Could not reach Stremio. Try again in a moment.';
	}

	if (body.error) {
		// 5992 is "Sync disabled", which Stremio also returns for a key it does not know.
		return body.error.code === 5992
			? 'Stremio did not accept that auth key (sync disabled).'
			: `Stremio answered: ${body.error.message ?? body.error.code ?? 'unknown error'}.`;
	}

	if (body.result === undefined) return 'Stremio answered in a shape we do not recognise.';
	return null;
}

// --- pages -----------------------------------------------------------------

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#e6e8ea;
font:16px/1.5 ui-sans-serif,system-ui,sans-serif;padding:24px}
main{width:100%;max-width:33rem;background:#111417;border:1px solid #1f262b;border-radius:14px;padding:28px}
h1{font-size:1.25rem;margin:0 0 4px}
p{color:#8b949e;margin:0 0 16px}
label{display:block;font-size:.875rem;font-weight:600;margin:18px 0 6px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #2b333a;background:#1a1e22;
color:#e6e8ea;font:inherit}
input:focus{outline:2px solid #2dd4bf;outline-offset:1px}
button,a.button{display:block;width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;
background:#2dd4bf;color:#00201d;font:inherit;font-weight:700;text-align:center;text-decoration:none;
cursor:pointer}
code{display:block;overflow-wrap:anywhere;background:#1a1e22;border:1px solid #2b333a;
border-radius:8px;padding:10px 12px;font-size:.8125rem;margin:8px 0}
code.inline{display:inline;padding:0;border:0;background:none;font-size:inherit}
.error{color:#f0b429}
.hint{font-size:.8125rem;color:#8b949e;margin:6px 0 0}
`.trim();

const HEADERS: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	// The handle in the URL is a credential, so neither page belongs in a cache or a Referer.
	'cache-control': 'no-store',
	'referrer-policy': 'no-referrer',
	'x-frame-options': 'DENY'
};

function page(title: string, main: string, status = 200): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Marquee bridge</title>
<style>${CSS}</style></head><body><main><h1>${title}</h1>${main}</main></body></html>`;

	return new Response(html, { status, headers: HEADERS });
}

export function renderForm(
	handle: string,
	error?: { field: PairingInputKey; message: string }
): Response {
	const message = error
		? `<p class="error" data-field="${error.field}">${error.message}</p>`
		: '<p>Connect this bridge to your Marquee account and your Stremio account.</p>';

	return page(
		'Connect Stremio',
		`${message}
<form method="post">
<label for="marqueeToken">Marquee API token</label>
<input id="marqueeToken" name="marqueeToken" type="password" required autocomplete="off"
 spellcheck="false" placeholder="mqr_…">
<p class="hint">Marquee → Settings → API tokens → new token, labelled “Stremio”.</p>
<label for="stremioAuthKey">Stremio auth key</label>
<input id="stremioAuthKey" name="stremioAuthKey" type="password" required autocomplete="off"
 spellcheck="false">
<p class="hint">Stremio on the web → DevTools → Application → Local Storage → <code
 class="inline">authKey</code>.</p>
<button type="submit">Connect</button>
</form>
<p class="hint">Bridge <code class="inline">${handle}</code></p>`,
		error ? 400 : 200
	);
}

export function renderResult(host: string, handle: string): Response {
	return page(
		'Connected',
		`<p>Add the addon to Stremio, then act on a title there to check it arrives in Marquee.</p>
<a class="button" href="stremio://${host}/${handle}/manifest.json">Install in Stremio</a>
<p class="hint">Or paste this manifest URL into Stremio's addon search:</p>
<code>https://${host}/${handle}/manifest.json</code>
<p class="hint">Keep this URL private — it is the only credential on the addon surface. Pairing
 the same bridge again replaces its credentials.</p>`
	);
}

export type PairingInputKey = keyof PairingInput;
