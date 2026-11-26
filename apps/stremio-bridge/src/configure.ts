/**
 * Pairing: the one-time exchange that turns a handle into a working bridge.
 *
 * Two credentials are pasted in — a Marquee API token and the user's Stremio `authKey` — and
 * each is checked against the service that issued it before anything is stored. No Stremio
 * password ever reaches this Worker: the `authKey` is what Stremio itself authorises with.
 */
import type { BridgeRecord } from './bridges';

/** The services a pairing is checked against. Passed in, so this module never reads `env`. */
export interface PairingContext {
	marqueeApi: string;
	stremioApi: string;
}

export interface PairingInput {
	marqueeToken: string;
	stremioAuthKey: string;
}

export type PairingInputKey = keyof PairingInput;

export type PairingResult =
	| { ok: true; record: BridgeRecord }
	/** `field` says which box to put the message under; the message is safe to show verbatim. */
	| { ok: false; field: PairingInputKey; message: string };

export async function pair(context: PairingContext, input: PairingInput): Promise<PairingResult> {
	const marqueeError = await checkMarquee(context.marqueeApi, input.marqueeToken);
	if (marqueeError) return { ok: false, field: 'marqueeToken', message: marqueeError };

	const stremioError = await checkStremio(context.stremioApi, input.stremioAuthKey);
	if (stremioError) return { ok: false, field: 'stremioAuthKey', message: stremioError };

	return {
		ok: true,
		record: {
			marqueeToken: input.marqueeToken,
			stremioAuthKey: input.stremioAuthKey,
			marqueeUrl: context.marqueeApi,
			createdAt: new Date().toISOString()
		}
	};
}

/**
 * One paged read proves the token, and doubles as a contract check: a 200 from something that is
 * not Marquee's read model — a moved host, a captive portal, a proxy — must not read as valid.
 */
async function checkMarquee(api: string, token: string): Promise<string | null> {
	let response: Response;
	try {
		response = await fetch(`${api}/api/v1/library?limit=1`, {
			headers: { authorization: `Bearer ${token}` }
		});
	} catch {
		return 'Could not reach Marquee. Try again in a moment.';
	}

	if (response.status === 401) return 'Marquee did not accept that token.';
	if (!response.ok) return `Marquee answered ${response.status}. Try again in a moment.`;

	const body = (await response.json().catch(() => null)) as { entries?: unknown } | null;
	if (!body || !Array.isArray(body.entries))
		return 'Marquee answered in a shape we do not recognise.';

	return null;
}

/**
 * `datastoreMeta` is the cheapest call that proves the key: it reads collection metadata without
 * returning the library. Stremio answers HTTP 200 with an `error` envelope, never a status code.
 */
async function checkStremio(api: string, authKey: string): Promise<string | null> {
	let envelope: { result?: unknown; error?: { code?: number; message?: string } } | null;
	try {
		const response = await fetch(`${api}/datastoreMeta`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ authKey, collection: 'libraryItem' })
		});
		envelope = await response.json();
	} catch {
		return 'Could not reach Stremio. Try again in a moment.';
	}

	// A JSON `null` body is answered rather than thrown on, so a broken upstream is a message
	// here instead of an unhandled TypeError and a 500.
	if (envelope?.error) {
		// 5992 is "Sync disabled", which Stremio also returns for a key it does not know.
		return envelope.error.code === 5992
			? 'Stremio did not accept that auth key (sync disabled).'
			: `Stremio answered: ${envelope.error.message ?? envelope.error.code ?? 'unknown error'}.`;
	}

	if (envelope?.result === undefined) return 'Stremio answered in a shape we do not recognise.';
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
button.secondary{background:#1a1e22;color:#e6e8ea;border:1px solid #2b333a}
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
	'x-frame-options': 'DENY',
	// Every value on these pages is either ours or escaped, so the CSP is the second fence.
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};

const ENTITIES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

/** `host` comes from the request and Stremio's error text is third-party: neither is markup. */
const escapeHtml = (value: string): string =>
	value.replace(/[&<>"']/g, (character) => ENTITIES[character]);

function page(title: string, main: string, status = 200): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Marquee bridge</title>
<style>${CSS}</style></head><body><main><h1>${title}</h1>${main}</main></body></html>`;

	return new Response(html, { status, headers: HEADERS });
}

export interface FormOptions {
	/** The error to show, and the field it belongs under. */
	error?: { field: PairingInputKey; message: string };
	/** The handle already holds a record: the only options are rotate the Stremio key, or disconnect. */
	paired?: boolean;
	status?: number;
}

export function renderForm(handle: string, options: FormOptions = {}): Response {
	const { error, paired = false, status = error ? 400 : 200 } = options;

	const message = error
		? `<p class="error" data-field="${error.field}">${escapeHtml(error.message)}</p>`
		: paired
			? '<p>This bridge is already paired. Replace its Stremio auth key, or disconnect it.</p>'
			: '<p>Connect this bridge to your Marquee account and your Stremio account.</p>';

	const token = `
<label for="marqueeToken">Marquee API token</label>
<input id="marqueeToken" name="marqueeToken" type="password" required autocomplete="off"
 spellcheck="false" placeholder="mqr_…">
<p class="hint">${paired ? 'The token this bridge is already paired with — it is how you prove the bridge is yours.' : 'Marquee → Settings → API tokens → new token, labelled “Stremio”.'}</p>`;

	const stremioKey = `
<label for="stremioAuthKey">Stremio auth key</label>
<input id="stremioAuthKey" name="stremioAuthKey" type="password" required autocomplete="off"
 spellcheck="false">
<p class="hint">Stremio on the web → DevTools → Application → Local Storage → <code
 class="inline">authKey</code>.</p>`;

	const body = paired
		? `${message}
<form method="post">
${token}${stremioKey}
<button type="submit">Replace the Stremio key</button>
</form>
<form method="post">
<input type="hidden" name="action" value="unpair">${token}
<button type="submit" class="secondary">Disconnect this bridge</button>
</form>
<p class="hint">Want to pair a different Marquee account? Start a new bridge — a paired handle
 can only be changed by whoever holds its token. Bridge <code class="inline">${escapeHtml(handle)}</code></p>`
		: `${message}
<form method="post">
${token}${stremioKey}
<button type="submit">Connect</button>
</form>
<p class="hint">Bridge <code class="inline">${escapeHtml(handle)}</code></p>`;

	return page(paired ? 'Bridge already paired' : 'Connect Stremio', body, status);
}

export function renderResult(host: string, handle: string, options: { unpaired?: boolean } = {}) {
	if (options.unpaired) {
		return page(
			'Disconnected',
			`<p>This bridge no longer holds your Marquee token or your Stremio auth key. Remove the
 addon from Stremio to stop it being called.</p>
<a class="button" href="/configure/${handle}">Pair it again</a>`
		);
	}

	const safeHost = escapeHtml(host);
	const safeHandle = escapeHtml(handle);

	return page(
		'Connected',
		`<p>Add the addon to Stremio. Actions you take there are recorded by this bridge; applying
 them to your Marquee library is the next step.</p>
<a class="button" href="stremio://${safeHost}/${safeHandle}/manifest.json">Install in Stremio</a>
<p class="hint">Or paste this manifest URL into Stremio's addon search:</p>
<code>https://${safeHost}/${safeHandle}/manifest.json</code>
<p class="hint">Keep this URL private — it is the only credential on the addon surface, and it is
 what proves the bridge is yours.</p>`
	);
}
