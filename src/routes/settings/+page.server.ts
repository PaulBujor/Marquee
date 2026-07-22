import { error, fail, redirect } from '@sveltejs/kit';
import {
	deleteAccount,
	deleteSessionCookie,
	EMAIL_CHANGE_TTL_MINUTES,
	normalizeEmail,
	requestEmailChange,
	verifyEmailChange
} from '$lib/server/auth';
import { codeField } from '$lib/validation';
import { createEmailSender } from '$lib/server/email';
import type { Actions, PageServerLoad } from './$types';

const SERVICE_UNAVAILABLE = 'Service unavailable.';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.db) error(503, SERVICE_UNAVAILABLE);
	if (!locals.user) redirect(303, '/login');
	return { user: locals.user, codeTtlMinutes: EMAIL_CHANGE_TTL_MINUTES };
};

/** Map a change-code verification failure to a message shown on the code step. */
function verifyErrorMessage(reason: 'invalid' | 'expired' | 'too_many_attempts' | 'taken'): string {
	switch (reason) {
		case 'expired':
			return 'That code has expired — start over to get a new one.';
		case 'too_many_attempts':
			return 'Too many attempts — start over to get a new code.';
		case 'taken':
			return 'That email address is no longer available.';
		default:
			return 'Incorrect code. Try again.';
	}
}

export const actions: Actions = {
	// Step 1: email a confirmation code to the new address.
	requestEmailChange: async ({ request, locals, platform, getClientAddress }) => {
		if (!locals.db || !platform) return fail(503, { message: SERVICE_UNAVAILABLE });
		if (!locals.user) return fail(401, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const newEmail = String(data.get('newEmail') ?? '');

		const sender = createEmailSender(platform.env);
		let result;
		try {
			result = await requestEmailChange({
				db: locals.db,
				user: locals.user,
				newEmail,
				sender,
				ip: getClientAddress()
			});
		} catch (err) {
			console.error('email-change request failed:', err);
			return fail(502, {
				newEmail,
				message: "We couldn't send the code right now. Please try again shortly."
			});
		}

		switch (result.kind) {
			case 'sent':
				return { step: 'code' as const, newEmail: normalizeEmail(newEmail) };
			case 'unchanged':
				return fail(400, { newEmail, message: "That's already your email address." });
			case 'taken':
				return fail(400, { newEmail, message: 'That email address is already in use.' });
			case 'rate_limited':
				return fail(429, {
					newEmail,
					message: 'Too many requests — try again in a little while.'
				});
			default:
				return fail(400, { newEmail, message: 'Enter a valid email address.' });
		}
	},

	// Step 2: verify the code and switch the account email.
	verifyEmailChange: async ({ request, locals }) => {
		if (!locals.db) return fail(503, { message: SERVICE_UNAVAILABLE });
		if (!locals.user) return fail(401, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const newEmail = String(data.get('newEmail') ?? '');
		const code = String(data.get('code') ?? '').trim();
		if (!codeField.safeParse(code).success) {
			return fail(400, { step: 'code' as const, newEmail, codeError: 'Enter the 6-digit code.' });
		}

		let result;
		try {
			result = await verifyEmailChange({ db: locals.db, user: locals.user, code });
		} catch (err) {
			console.error('email-change verification failed:', err);
			return fail(502, { step: 'code' as const, newEmail, codeError: SERVICE_UNAVAILABLE });
		}

		if (result.ok) return { step: 'done' as const, newEmail: result.newEmail };
		return fail(400, {
			step: 'code' as const,
			newEmail,
			codeError: verifyErrorMessage(result.reason)
		});
	},

	// Permanently delete the account. Requires typing the current email to confirm.
	deleteAccount: async ({ request, locals, cookies }) => {
		if (!locals.db) return fail(503, { message: SERVICE_UNAVAILABLE });
		if (!locals.user) return fail(401, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const confirm = normalizeEmail(String(data.get('confirmEmail') ?? ''));
		if (confirm !== locals.user.email) {
			return fail(400, { deleteError: 'That email does not match this account.' });
		}

		await deleteAccount(locals.db, locals.user);
		deleteSessionCookie(cookies);
		redirect(303, '/login');
	}
};
