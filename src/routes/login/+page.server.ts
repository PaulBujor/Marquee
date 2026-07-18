import { fail, redirect } from '@sveltejs/kit';
import {
	CODE_TTL_MINUTES,
	joinWaitlist,
	LINK_TTL_MINUTES,
	normalizeEmail,
	requestSignIn,
	setSessionCookie,
	verifyCode,
	type SignInMode
} from '$lib/server/auth';
import { createEmailSender } from '$lib/server/email';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVICE_UNAVAILABLE = 'Service unavailable.';
const INVALID_EMAIL = 'Enter a valid email address.';
const SEND_FAILED = "We couldn't send the email right now. Please try again shortly.";

function parseMode(value: FormDataEntryValue | null): SignInMode {
	return value === 'standalone' ? 'standalone' : 'browser';
}

/** Map a `?error=` from the magic-link redirect to a message shown on the form. */
function linkErrorMessage(error: string | null): string | null {
	if (!error) return null;
	switch (error) {
		case 'expired':
			return 'That sign-in link has expired. Request a new one below.';
		case 'not_allowed':
			return "This account can't sign in right now.";
		default:
			return 'That sign-in link is invalid. Request a new one below.';
	}
}

/** Map a code-verification failure to a message shown on the code step. */
function codeErrorMessage(
	reason: 'invalid' | 'expired' | 'not_allowed' | 'too_many_attempts'
): string {
	switch (reason) {
		case 'expired':
			return 'That code has expired — request a new one.';
		case 'too_many_attempts':
			return 'Too many attempts — request a new code.';
		case 'not_allowed':
			return "This account can't sign in right now.";
		default:
			return 'Incorrect code. Try again.';
	}
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) redirect(303, '/');

	const linkError = linkErrorMessage(url.searchParams.get('error'));
	return { linkError, linkTtlMinutes: LINK_TTL_MINUTES, codeTtlMinutes: CODE_TTL_MINUTES };
};

export const actions: Actions = {
	// Request phase: branch on status; email a link (browser) or a code (PWA) per `mode`.
	request: async ({ request, locals, platform, url, getClientAddress }) => {
		if (!locals.db || !platform) return fail(503, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		if (!EMAIL_RE.test(email.trim())) return fail(400, { email, message: INVALID_EMAIL });

		const sender = createEmailSender(platform.env);
		try {
			const result = await requestSignIn({
				db: locals.db,
				email,
				sender,
				origin: url.origin,
				mode: parseMode(data.get('mode')),
				ip: getClientAddress()
			});
			return {
				step: 'request' as const,
				email: normalizeEmail(email),
				result: result.kind,
				method: result.kind === 'sent' ? result.method : undefined
			};
		} catch (err) {
			console.error('sign-in request failed:', err);
			return fail(502, { email, message: SEND_FAILED });
		}
	},

	// Verify phase (PWA code flow): match the emailed code and mint a session.
	verify: async ({ request, locals, cookies }) => {
		if (!locals.db) return fail(503, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const code = String(data.get('code') ?? '').trim();
		if (!/^\d{6}$/.test(code)) {
			return fail(400, { step: 'code' as const, email, codeError: 'Enter the 6-digit code.' });
		}

		let result;
		try {
			result = await verifyCode(locals.db, email, code);
		} catch (err) {
			console.error('code verification failed:', err);
			return fail(502, { step: 'code' as const, email, codeError: SERVICE_UNAVAILABLE });
		}
		if (result.ok) {
			setSessionCookie(cookies, result.token, result.expiresAt);
			redirect(303, '/');
		}

		return fail(400, { step: 'code' as const, email, codeError: codeErrorMessage(result.reason) });
	},

	// Waitlist signup for a previously-unknown address (creates a pending user + emails a confirmation).
	join: async ({ request, locals, platform, getClientAddress }) => {
		if (!locals.db || !platform) return fail(503, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		if (!EMAIL_RE.test(email.trim())) return fail(400, { email, message: INVALID_EMAIL });

		const sender = createEmailSender(platform.env);
		try {
			const result = await joinWaitlist(locals.db, email, sender, getClientAddress());
			return { step: 'join' as const, email: normalizeEmail(email), result: result.kind };
		} catch (err) {
			console.error('waitlist signup failed:', err);
			return fail(502, { email, message: SEND_FAILED });
		}
	}
};
