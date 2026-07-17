import { fail, redirect } from '@sveltejs/kit';
import { normalizeEmail, requestMagicLink } from '$lib/server/auth';
import { createEmailSender } from '$lib/server/email';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, locals, platform, url }) => {
		if (!locals.db || !platform) return fail(503, { message: 'Service unavailable.' });

		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		if (!EMAIL_RE.test(email.trim())) {
			return fail(400, { email, message: 'Enter a valid email address.' });
		}

		const sender = createEmailSender(platform.env);
		const ok = await requestMagicLink({ db: locals.db, email, sender, origin: url.origin });
		if (!ok) {
			return fail(429, { email, message: 'Too many requests — try again in a few minutes.' });
		}

		return { sent: true, email: normalizeEmail(email) };
	}
};
