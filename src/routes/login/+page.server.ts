import { env } from '#lib/server/bindings.js';
import { fail, redirect } from '@sveltejs/kit';
import {
	CODE_TTL_MINUTES,
	joinWaitlist,
	LINK_TTL_MINUTES,
	normalizeEmail,
	requestSignIn,
	setSessionCookie,
	verifyCode
} from '#lib/server/auth/index.js';
import { codeField, emailField, firstError, signInModeField } from '#lib/validation/index.js';
import { createEmailSender } from '#lib/server/email/index.js';
import { safeRedirectPath } from '#lib/redirect.js';
import type { Actions, PageServerLoad } from './$types';

const SERVICE_UNAVAILABLE = 'Service unavailable.';
const INVALID_EMAIL = 'Enter a valid email address.';
const SEND_FAILED = "We couldn't send the email right now. Please try again shortly.";

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
	return {
		linkError,
		linkTtlMinutes: LINK_TTL_MINUTES,
		codeTtlMinutes: CODE_TTL_MINUTES,
		redirectTo: safeRedirectPath(url.searchParams.get('redirectTo'))
	};
};

export const actions: Actions = {
	request: async ({ request, locals, url, getClientAddress }) => {
		if (!locals.db) return fail(503, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const parsedEmail = emailField.safeParse(email);
		if (!parsedEmail.success) {
			return fail(400, { email, message: firstError(parsedEmail.error) ?? INVALID_EMAIL });
		}

		const sender = createEmailSender(env);
		try {
			const result = await requestSignIn({
				db: locals.db,
				email,
				sender,
				origin: url.origin,
				mode: signInModeField.parse(data.get('mode')),
				ip: getClientAddress(),
				redirectTo: safeRedirectPath(data.get('redirectTo'))
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

	verify: async ({ request, locals, cookies }) => {
		if (!locals.db) return fail(503, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const code = String(data.get('code') ?? '').trim();
		// Display-only, echoed back so a wrong code doesn't collapse the combined card to code-only.
		const method = data.get('method') === 'link_and_code' ? 'link_and_code' : 'code';
		const redirectTo = safeRedirectPath(data.get('redirectTo'));
		if (!codeField.safeParse(code).success) {
			return fail(400, {
				step: 'code' as const,
				email,
				method,
				codeError: 'Enter the 6-digit code.'
			});
		}

		let result;
		try {
			result = await verifyCode(locals.db, email, code);
		} catch (err) {
			console.error('code verification failed:', err);
			return fail(502, { step: 'code' as const, email, method, codeError: SERVICE_UNAVAILABLE });
		}
		if (result.ok) {
			setSessionCookie(cookies, result.token, result.expiresAt);
			redirect(303, redirectTo);
		}

		return fail(400, {
			step: 'code' as const,
			email,
			method,
			codeError: codeErrorMessage(result.reason)
		});
	},

	join: async ({ request, locals, getClientAddress }) => {
		if (!locals.db) return fail(503, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const parsedEmail = emailField.safeParse(email);
		if (!parsedEmail.success) {
			return fail(400, { email, message: firstError(parsedEmail.error) ?? INVALID_EMAIL });
		}

		const sender = createEmailSender(env);
		try {
			const result = await joinWaitlist(locals.db, email, sender, getClientAddress());
			return { step: 'join' as const, email: normalizeEmail(email), result: result.kind };
		} catch (err) {
			console.error('waitlist signup failed:', err);
			return fail(502, { email, message: SEND_FAILED });
		}
	}
};
