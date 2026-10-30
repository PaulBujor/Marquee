// Mirrors the LIGHT design tokens in src/routes/layout.css — mail renders on white; keep in sync.
const BRAND = '#0f766e'; // --primary
const SERIF = "'Fraunces', ui-serif, Georgia, serif";
const MUTED = 'color: #5c6470; font-size: 13px;'; // --muted-foreground
const IGNORE_REQUEST = "If you didn't request this, you can safely ignore this email.";

/** `EMAIL_REGEX` allows `<` and `>`, so the address the user typed must be escaped, not just the codes and links. */
function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function layout(heading: string, body: string): string {
	return `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet" />
	</head>
	<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #0b0d0f;">
		<h2 style="margin: 0 0 16px; font-family: ${SERIF}; font-weight: 600;">${heading}</h2>
		${body}
	</body>
</html>`;
}

function codeBlock(code: string, margin = '24px 0'): string {
	return `<p style="margin: ${margin}; font-size: 32px; font-weight: 700; letter-spacing: 8px; font-family: ui-monospace, 'SF Mono', Menlo, monospace;">${code}</p>`;
}

/** The link and code TTLs differ on purpose — see the auth module. */
export function renderMagicLinkAndCodeEmail(
	url: string,
	code: string,
	linkTtlMinutes: number,
	codeTtlMinutes: number
): string {
	return layout(
		'Sign in to Marquee',
		`<p>Click the button below to sign in. This link expires in ${linkTtlMinutes} minutes and can be used once.</p>
		<p style="margin: 24px 0;">
			<a href="${url}" style="background: ${BRAND}; color: #ffffff; padding: 12px 20px; border-radius: 10px; text-decoration: none; display: inline-block; font-size: 14px; font-weight: 500;">Sign in to Marquee</a>
		</p>
		<p style="${MUTED} word-break: break-all;">Or paste this link into your browser:<br />${url}</p>
		<p style="margin: 24px 0 8px;">Prefer to type a code? Enter this in Marquee — it expires in ${codeTtlMinutes} minutes.</p>
		${codeBlock(code, '0 0 24px')}
		<p style="${MUTED}">${IGNORE_REQUEST}</p>`
	);
}

export function renderCodeEmail(code: string, ttlMinutes: number): string {
	return layout(
		'Your sign-in code',
		`<p>Enter this code in Marquee to sign in. It expires in ${ttlMinutes} minutes.</p>
		${codeBlock(code)}
		<p style="${MUTED}">${IGNORE_REQUEST}</p>`
	);
}

export function renderEmailChangeCode(code: string, ttlMinutes: number): string {
	return layout(
		'Confirm your new email',
		`<p>Enter this code in Marquee to confirm this as your new account email. It expires in ${ttlMinutes} minutes.</p>
		${codeBlock(code)}
		<p style="${MUTED}">If you didn't request this change, you can safely ignore this email — your address won't change.</p>`
	);
}

/** Sent to the **previous** address: sign-in is passwordless and keyed on the address, so this is the only signal it moved. */
export function renderEmailChangedNotice(newEmail: string): string {
	return layout(
		'Your Marquee email was changed',
		`<p>The email address on your Marquee account was changed to <strong>${escapeHtml(newEmail)}</strong>. Sign-in codes and links will now go there instead.</p>
		<p>You've been signed out on your other devices.</p>
		<p style="${MUTED}">If you didn't make this change, contact us right away — whoever made it now controls the account.</p>`
	);
}

export function renderWaitlistEmail(): string {
	return layout(
		"You're on the waitlist",
		`<p>Thanks for your interest in Marquee — you're on the list. We'll email you as soon as your account is ready to sign in.</p>
		<p style="${MUTED}">If you didn't sign up, you can safely ignore this email.</p>`
	);
}

export function renderWelcomeEmail(): string {
	return layout(
		"You're in",
		`<p>Your Marquee account is ready — you can sign in with your email address now, no password to remember.</p>
		<p style="${MUTED}">Thanks for waiting.</p>`
	);
}

export function renderAccountBlockedEmail(reason: string): string {
	return layout(
		'Your access to Marquee has been removed',
		`<p>An administrator has removed your access to Marquee.</p>
		<p style="${MUTED}">Reason given: ${escapeHtml(reason)}</p>
		<p style="${MUTED}">If you think this was a mistake, reply to this email and we'll take another look.</p>`
	);
}

export function renderAccountRestoredEmail(): string {
	return layout(
		'Your Marquee access is back',
		`<p>An administrator has restored your access to Marquee — you can sign in with your email address again.</p>
		<p style="${MUTED}">Sorry for the interruption.</p>`
	);
}

export function renderWaitlistDigestEmail(
	pending: { email: string; signedUpAt: string }[]
): string {
	const rows = pending
		.map(
			(entry) =>
				`<li style="margin: 0 0 4px;">${escapeHtml(entry.email)} <span style="${MUTED}">${escapeHtml(entry.signedUpAt)}</span></li>`
		)
		.join('');
	return layout(
		pending.length === 1 ? '1 account is waiting' : `${pending.length} accounts are waiting`,
		`<p>These people signed up and are waiting to be admitted:</p>
		<ul style="margin: 0; padding-left: 18px;">${rows}</ul>
		<p style="${MUTED}">Admit them from Admin → Users.</p>`
	);
}

export function renderAccountDeletedEmail(): string {
	return layout(
		'Your account has been deleted',
		`<p>Your Marquee account and everything associated with it have been permanently deleted. This can't be undone.</p>
		<p>Thanks for having used Marquee — you're welcome back any time by signing up again.</p>
		<p style="${MUTED}">If you didn't request this, please contact us right away.</p>`
	);
}
