import { fail, redirect } from '@sveltejs/kit';
import {
	deleteAccount,
	deleteSessionCookie,
	normalizeEmail,
	requestEmailChange,
	SESSION_COOKIE,
	verifyEmailChange
} from '$lib/server/auth';
import { codeField } from '$lib/validation';
import { createEmailSender } from '$lib/server/email';
import { renderAccountDeletedEmail, renderEmailChangedNotice } from '$lib/server/email/templates';
import type { Actions } from './$types';

const SERVICE_UNAVAILABLE = 'Service unavailable.';

// The page load is universal (`+page.ts`) so settings works offline — only the actions below need
// the server (and the UI gates them offline).

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
	verifyEmailChange: async ({ request, locals, platform, cookies }) => {
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
			result = await verifyEmailChange({
				db: locals.db,
				user: locals.user,
				code,
				// Keep this device signed in; every other session is dropped.
				keepSessionToken: cookies.get(SESSION_COOKIE) ?? null
			});
		} catch (err) {
			console.error('email-change verification failed:', err);
			return fail(502, { step: 'code' as const, newEmail, codeError: SERVICE_UNAVAILABLE });
		}

		if (result.ok) {
			// Tell the address that just lost the account. Best-effort and fire-and-forget, like the
			// deletion notice: the change is already committed, so a mail failure must not fail it.
			if (platform) {
				try {
					const sender = createEmailSender(platform.env);
					platform.ctx.waitUntil(
						sender
							.send({
								to: result.previousEmail,
								subject: 'Your Marquee email was changed',
								html: renderEmailChangedNotice(result.newEmail)
							})
							.catch((err) => console.error('email-change notice failed:', err))
					);
				} catch (err) {
					console.error('email-change notice setup failed:', err);
				}
			}
			return { step: 'done' as const, newEmail: result.newEmail };
		}
		return fail(400, {
			step: 'code' as const,
			newEmail,
			codeError: verifyErrorMessage(result.reason)
		});
	},

	// Permanently delete the account. Requires typing the current email to confirm.
	deleteAccount: async ({ request, locals, platform, cookies }) => {
		if (!locals.db) return fail(503, { message: SERVICE_UNAVAILABLE });
		if (!locals.user) return fail(401, { message: SERVICE_UNAVAILABLE });

		const data = await request.formData();
		const confirm = normalizeEmail(String(data.get('confirmEmail') ?? ''));
		if (confirm !== locals.user.email) {
			return fail(400, { deleteError: 'That email does not match this account.' });
		}

		const email = locals.user.email;
		await deleteAccount(locals.db, locals.user);
		deleteSessionCookie(cookies);

		// Confirm the deletion by email — best-effort, so a mail failure can't undo (or fail) a
		// deletion that's already committed. Fire-and-forget via the request's ExecutionContext so it
		// doesn't delay the redirect. Only when the transport is configured (`platform` present).
		if (platform) {
			try {
				const sender = createEmailSender(platform.env);
				platform.ctx.waitUntil(
					sender
						.send({
							to: email,
							subject: 'Your Marquee account has been deleted',
							html: renderAccountDeletedEmail()
						})
						.catch((err) => console.error('account-deletion email failed:', err))
				);
			} catch (err) {
				console.error('account-deletion email setup failed:', err);
			}
		}

		redirect(303, '/login');
	}
};
