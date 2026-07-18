import { fail, redirect } from '@sveltejs/kit';
import { joinWaitlist, normalizeEmail, requestMagicLink } from '$lib/server/auth';
import { createEmailSender } from '$lib/server/email';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVICE_UNAVAILABLE = 'Service unavailable.';
const INVALID_EMAIL = 'Enter a valid email address.';
const SEND_FAILED = "We couldn't send the email right now. Please try again shortly.";

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) redirect(303, '/');

	const error = url.searchParams.get('error');
	const linkError =
		error === 'expired'
			? 'That sign-in link has expired. Request a new one below.'
			: error === 'not_allowed'
				? "This account can't sign in right now."
				: error
					? 'That sign-in link is invalid. Request a new one below.'
					: null;
	return { linkError };
};

export const actions: Actions = {
	// Request phase: branch on account status (sent / blocked / waitlisted / unknown / rate_limited).
	request: async ({ request, locals, platform, url, getClientAddress }) => {
		if (!locals.db || !platform) return fail(503, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		if (!EMAIL_RE.test(email.trim())) return fail(400, { email, message: INVALID_EMAIL });

		const sender = createEmailSender(platform.env);
		try {
			const result = await requestMagicLink({
				db: locals.db,
				email,
				sender,
				origin: url.origin,
				ip: getClientAddress()
			});
			return { step: 'request' as const, email: normalizeEmail(email), result: result.kind };
		} catch (err) {
			console.error('magic-link request failed:', err);
			return fail(502, { email, message: SEND_FAILED });
		}
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
