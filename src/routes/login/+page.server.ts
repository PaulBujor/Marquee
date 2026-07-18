import { fail, redirect } from '@sveltejs/kit';
import { joinWaitlist, normalizeEmail, requestMagicLink } from '$lib/server/auth';
import { createEmailSender } from '$lib/server/email';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
		if (!locals.db || !platform) return fail(503, { message: 'Service unavailable.' });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		if (!EMAIL_RE.test(email.trim())) {
			return fail(400, { email, message: 'Enter a valid email address.' });
		}

		const sender = createEmailSender(platform.env);
		const result = await requestMagicLink({
			db: locals.db,
			email,
			sender,
			origin: url.origin,
			ip: getClientAddress()
		});
		return { step: 'request' as const, email: normalizeEmail(email), result: result.kind };
	},

	// Waitlist signup for a previously-unknown address (creates a pending user).
	join: async ({ request, locals }) => {
		if (!locals.db) return fail(503, { message: 'Service unavailable.' });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		if (!EMAIL_RE.test(email.trim())) {
			return fail(400, { email, message: 'Enter a valid email address.' });
		}

		const result = await joinWaitlist(locals.db, email);
		return { step: 'join' as const, email: normalizeEmail(email), result: result.kind };
	}
};
