import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { BLOCK_REFUSALS, ENABLE_REFUSALS, blockUser, enableUser } from '#lib/server/admin/users.js';
import { DELETE_REFUSALS, deleteUser } from '#lib/server/auth/deletion.js';
import { requireAdmin } from '#lib/server/admin/guard.js';
import { auditStatement } from '#lib/server/admin/audit.js';
import { env } from '#lib/server/bindings.js';
import { users } from '#lib/server/db/schema.js';
import { createEmailSender } from '#lib/server/email/index.js';
import {
	renderAccountBlockedEmail,
	renderAccountDeletedEmail,
	renderAccountRestoredEmail,
	renderWelcomeEmail
} from '#lib/server/email/templates.js';

const MIN_REASON = 5;

export const load: PageServerLoad = async ({ locals, params }) => {
	const actor = requireAdmin(locals.user);
	if (!locals.db) error(503, 'Service unavailable');

	const [target] = await locals.db
		.select({
			id: users.id,
			email: users.email,
			status: users.status,
			role: users.role,
			blockedReason: users.blockedReason,
			signupIp: users.signupIp,
			createdAt: users.createdAt
		})
		.from(users)
		.where(eq(users.id, params.id))
		.limit(1);

	if (!target) error(404, 'Not found');

	return { target, isSelf: actor.id === target.id };
};

export const actions: Actions = {
	block: async ({ locals, params, request, getClientAddress }) => {
		const actor = requireAdmin(locals.user);
		if (!locals.db) error(503, 'Service unavailable');

		const reason = String((await request.formData()).get('reason') ?? '').trim();
		if (reason.length < MIN_REASON) {
			return fail(400, { reason, message: `Give a reason of at least ${MIN_REASON} characters.` });
		}

		const result = await blockUser(
			locals.db,
			{ id: actor.id, email: actor.email },
			params.id,
			reason,
			getClientAddress()
		);
		if (!result.ok) return fail(400, { reason, message: BLOCK_REFUSALS[result.refusal] });

		// The block is committed, so a failed send is reported rather than rolled back.
		let emailed = true;
		try {
			await createEmailSender(env).send({
				to: result.email,
				subject: 'Your access to Marquee has been removed',
				html: renderAccountBlockedEmail(reason)
			});
		} catch {
			emailed = false;
		}

		return { blocked: true, emailed, reason };
	},

	enable: async ({ locals, params, getClientAddress }) => {
		const actor = requireAdmin(locals.user);
		if (!locals.db) error(503, 'Service unavailable');

		const result = await enableUser(
			locals.db,
			{ id: actor.id, email: actor.email },
			params.id,
			getClientAddress()
		);
		if (!result.ok) return fail(400, { message: ENABLE_REFUSALS[result.refusal] });

		let emailed = true;
		try {
			await createEmailSender(env).send({
				to: result.email,
				subject: "You're in — Marquee",
				html: renderWelcomeEmail()
			});
		} catch {
			emailed = false;
		}

		return { enabled: true, emailed };
	},

	delete: async ({ locals, params, request, getClientAddress }) => {
		const actor = requireAdmin(locals.user);
		if (!locals.db) error(503, 'Service unavailable');

		const [target] = await locals.db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, params.id))
			.limit(1);
		if (!target) error(404, 'Not found');

		const confirmation = String((await request.formData()).get('confirm') ?? '').trim();
		if (confirmation !== target.email) {
			return fail(400, { deleteError: 'Type the account email exactly to confirm.' });
		}

		const result = await deleteUser(
			locals.db,
			{ id: actor.id, email: actor.email },
			params.id,
			getClientAddress()
		);
		if (!result.ok) return fail(400, { deleteError: DELETE_REFUSALS[result.refusal] });

		let emailed = true;
		try {
			await createEmailSender(env).send({
				to: result.email,
				subject: 'Your Marquee account has been deleted',
				html: renderAccountDeletedEmail()
			});
		} catch {
			emailed = false;
		}
		if (!emailed) console.error('admin: account deleted but the notice email failed', result.email);

		redirect(303, '/admin/users');
	},

	unblock: async ({ locals, params, getClientAddress }) => {
		const actor = requireAdmin(locals.user);
		if (!locals.db) error(503, 'Service unavailable');

		const [target] = await locals.db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, params.id))
			.limit(1);
		if (!target) error(404, 'Not found');

		await locals.db.batch([
			locals.db
				.update(users)
				.set({ status: 'enabled', blockedReason: null, updatedAt: new Date() })
				.where(eq(users.id, params.id)),
			auditStatement(locals.db, {
				actor: { id: actor.id, email: actor.email },
				action: 'user.unblock',
				target: { type: 'user', id: params.id, label: target.email },
				ip: getClientAddress()
			})
		]);

		let emailed = true;
		try {
			await createEmailSender(env).send({
				to: target.email,
				subject: 'Your Marquee access is back',
				html: renderAccountRestoredEmail()
			});
		} catch {
			emailed = false;
		}

		return { unblocked: true, emailed };
	}
};
