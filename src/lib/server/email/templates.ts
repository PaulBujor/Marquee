/**
 * Transactional email bodies for the auth flows. Kept apart from the send
 * transport (`./index`) and the auth logic (`../auth`) so the markup lives in
 * one place. Inline styles because email clients ignore <style>/external CSS.
 */

const BRAND = '#8b5cf6';
const SERIF = "'Fraunces', ui-serif, Georgia, serif";
const MUTED = 'color: #666; font-size: 13px;';
const IGNORE_REQUEST = "If you didn't request this, you can safely ignore this email.";

/** Shared shell: doctype + base typography + a serif heading. */
function layout(heading: string, body: string): string {
	return `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet" />
	</head>
	<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
		<h2 style="margin: 0 0 16px; font-family: ${SERIF}; font-weight: 600;">${heading}</h2>
		${body}
	</body>
</html>`;
}

export function renderMagicLinkEmail(url: string, ttlMinutes: number): string {
	return layout(
		'Sign in to Marquee',
		`<p>Click the button below to sign in. This link expires in ${ttlMinutes} minutes and can be used once.</p>
		<p style="margin: 24px 0;">
			<a href="${url}" style="background: ${BRAND}; color: #ffffff; padding: 12px 20px; border-radius: 10px; text-decoration: none; display: inline-block; font-size: 14px; font-weight: 500;">Sign in to Marquee</a>
		</p>
		<p style="${MUTED}">${IGNORE_REQUEST}</p>
		<p style="${MUTED} word-break: break-all;">Or paste this link into your browser:<br />${url}</p>`
	);
}

export function renderCodeEmail(code: string, ttlMinutes: number): string {
	return layout(
		'Your sign-in code',
		`<p>Enter this code in Marquee to sign in. It expires in ${ttlMinutes} minutes.</p>
		<p style="margin: 24px 0; font-size: 32px; font-weight: 700; letter-spacing: 8px; font-family: ui-monospace, 'SF Mono', Menlo, monospace;">${code}</p>
		<p style="${MUTED}">${IGNORE_REQUEST}</p>`
	);
}

export function renderEmailChangeCode(code: string, ttlMinutes: number): string {
	return layout(
		'Confirm your new email',
		`<p>Enter this code in Marquee to confirm this as your new account email. It expires in ${ttlMinutes} minutes.</p>
		<p style="margin: 24px 0; font-size: 32px; font-weight: 700; letter-spacing: 8px; font-family: ui-monospace, 'SF Mono', Menlo, monospace;">${code}</p>
		<p style="${MUTED}">If you didn't request this change, you can safely ignore this email — your address won't change.</p>`
	);
}

export function renderWaitlistEmail(): string {
	return layout(
		"You're on the waitlist",
		`<p>Thanks for your interest in Marquee — you're on the list. We'll email you as soon as your account is ready to sign in.</p>
		<p style="${MUTED}">If you didn't sign up, you can safely ignore this email.</p>`
	);
}
