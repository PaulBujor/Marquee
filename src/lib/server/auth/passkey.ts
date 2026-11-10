import { and, count, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import type { Cookies } from '@sveltejs/kit';
import { problem } from '#lib/server/http/problem.js';
import type { createDb } from '#lib/server/db/index.js';
import {
	passkeyChallenges,
	passkeys,
	users,
	type Passkey,
	type User
} from '#lib/server/db/schema.js';

type Db = ReturnType<typeof createDb>;

/**
 * Carries only the challenge row's id; the challenge itself never leaves the database. Two names, so a
 * sign-in already in flight is not clobbered by a passkey being added in another tab.
 */
export const PASSKEY_COOKIE = 'passkey_challenge';
export const PASSKEY_ENROLL_COOKIE = 'passkey_enroll_challenge';
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PASSKEY_NAME_MAX = 40;
/** Enrolling a credential outlives every session, so it needs a recent sign-in, not just any session. */
export const REAUTH_WINDOW_MS = 15 * 60 * 1000;
/** Bounds in-flight ceremonies per client: the sign-in options endpoint is public and writes a row. */
const LIVE_CHALLENGES = 10;
const RP_NAME = 'Marquee';
/** The transports WebAuthn defines; anything else the client sends is discarded. */
const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);

export function setChallengeCookie(cookies: Cookies, name: string, challengeId: string): void {
	cookies.set(name, challengeId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		maxAge: CHALLENGE_TTL_MS / 1000
	});
}

export function clearChallengeCookie(cookies: Cookies, name: string): void {
	cookies.delete(name, { path: '/' });
}

/**
 * Enrolling or removing a credential can outlive or undo every other recovery lever, so it needs a
 * recent sign-in rather than any live session. Returns the 403 to send, or null when allowed.
 */
export function requireRecentSignIn(scope: {
	session: { createdAt: Date } | null;
}): Response | null {
	if (scope.session && isRecentSignIn(scope.session)) return null;
	return problem(403, 'Sign in again', {
		detail: 'Adding or removing a passkey needs a recent sign-in. Sign out and back in, then retry.'
	});
}

/** `session.createdAt` is the sign-in time; `validateSession` only refreshes expiry and last use. */
export function isRecentSignIn(session: { createdAt: Date }, now: number = Date.now()): boolean {
	return now - session.createdAt.getTime() <= REAUTH_WINDOW_MS;
}

/**
 * A credential is bound to the hostname it was created on, so the relying party follows the request
 * rather than config: localhost, Workers previews and the custom domain each stay self-consistent.
 */
function relyingParty(url: URL): { rpID: string; origin: string } {
	return { rpID: url.hostname, origin: url.origin };
}

async function storeChallenge(
	db: Db,
	challenge: string,
	owner: { userId: string } | 'anonymous',
	meta: { rpId: string; ip?: string | null }
): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(passkeyChallenges).values({
		id,
		challenge,
		userId: owner === 'anonymous' ? null : owner.userId,
		rpId: meta.rpId,
		requestIp: meta.ip ?? null,
		expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS)
	});
	return id;
}

/** Live (unexpired) ceremonies this client has open; the ones it abandoned are never cleaned per-request. */
async function liveChallenges(db: Db, ip: string): Promise<number> {
	const [{ n }] = await db
		.select({ n: count() })
		.from(passkeyChallenges)
		.where(and(eq(passkeyChallenges.requestIp, ip), gt(passkeyChallenges.expiresAt, new Date())));
	return n;
}

/** Single use: the row is deleted as it's read, so a replayed ceremony finds nothing to match. */
async function takeChallenge(
	db: Db,
	id: string | undefined,
	owner: { userId: string } | 'anonymous',
	rpId: string
): Promise<string | null> {
	if (!id) return null;
	const deleted = await db
		.delete(passkeyChallenges)
		.where(
			owner === 'anonymous'
				? and(eq(passkeyChallenges.id, id), isNull(passkeyChallenges.userId))
				: and(eq(passkeyChallenges.id, id), eq(passkeyChallenges.userId, owner.userId))
		)
		.returning({
			challenge: passkeyChallenges.challenge,
			expiresAt: passkeyChallenges.expiresAt,
			rpId: passkeyChallenges.rpId
		});
	const row = deleted.at(0);
	if (!row || row.expiresAt.getTime() <= Date.now()) return null;
	// A challenge is only ever completed on the host it was issued for.
	if (row.rpId !== rpId) return null;
	return row.challenge;
}

/**
 * Request bodies as they arrive from the browser. Loose, because SimpleWebAuthn inspects the rest of
 * each response and throws on anything malformed — stripping unknown keys would break that.
 */
export const registrationBodySchema = z.object({
	name: z.string().trim().max(PASSKEY_NAME_MAX).optional(),
	response: z.object({ id: z.string().min(1), type: z.literal('public-key') }).loose()
});

export const authenticationBodySchema = z.object({
	response: z.object({ id: z.string().min(1), type: z.literal('public-key') }).loose(),
	redirectTo: z.string().max(512).optional()
});

export interface PasskeyOptions<T> {
	options: T;
	challengeId: string;
}

/** Resident key required: sign-in has to work from a discoverable credential with no email typed. */
export interface CeremonyOpts {
	/** Client address, used only to bound in-flight ceremonies. */
	ip?: string | null;
	/** This browser's previous challenge id, superseded so pageviews don't accumulate rows. */
	previousChallengeId?: string;
}

/** Null when this client already has too many ceremonies open. */
async function supersedeAndThrottle(db: Db, opts: CeremonyOpts): Promise<{ throttled: boolean }> {
	if (opts.previousChallengeId)
		await db.delete(passkeyChallenges).where(eq(passkeyChallenges.id, opts.previousChallengeId));
	// Counting after the delete, so a browser replacing its own challenge is never pushed over.
	const open = opts.ip ? await liveChallenges(db, opts.ip) : 0;
	return { throttled: open >= LIVE_CHALLENGES };
}

export async function startRegistration(
	db: Db,
	user: User,
	url: URL,
	opts: CeremonyOpts = {}
): Promise<PasskeyOptions<PublicKeyCredentialCreationOptionsJSON> | null> {
	if ((await supersedeAndThrottle(db, opts)).throttled) return null;

	const existing = await db
		.select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
		.from(passkeys)
		.where(eq(passkeys.userId, user.id));

	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		...relyingParty(url),
		// The user handle is our id, not the email: it's visible to the authenticator and may change.
		userID: isoUint8Array.fromUTF8String(user.id),
		userName: user.email,
		userDisplayName: user.email,
		attestationType: 'none',
		excludeCredentials: existing.map((row) => ({
			id: row.credentialId,
			transports: row.transports ?? undefined
		})),
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
	});
	return {
		options,
		challengeId: await storeChallenge(
			db,
			options.challenge,
			{ userId: user.id },
			{
				rpId: url.hostname,
				ip: opts.ip
			}
		)
	};
}

/**
 * A credential id that already belongs to another account must never be taken over. Registration
 * upserts by `credential_id`, so without this check a row could be re-pointed at the caller.
 */
export async function credentialOwnedByOtherUser(
	db: Db,
	credentialId: string,
	userId: string
): Promise<boolean> {
	const owner = (
		await db
			.select({ userId: passkeys.userId })
			.from(passkeys)
			.where(eq(passkeys.credentialId, credentialId))
			.limit(1)
	).at(0);
	return owner !== undefined && owner.userId !== userId;
}

/** Stores the credential; returns false when the response doesn't verify or the ceremony is stale. */
export async function finishRegistration(opts: {
	db: Db;
	user: User;
	url: URL;
	challengeId: string | undefined;
	response: RegistrationResponseJSON;
	name: string;
}): Promise<boolean> {
	const { db, user, url, challengeId, response, name } = opts;
	const challenge = await takeChallenge(db, challengeId, { userId: user.id }, url.hostname);
	if (!challenge) return false;

	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: url.origin,
			expectedRPID: url.hostname,
			requireUserVerification: true
		});
	} catch (err) {
		console.error('passkey registration failed:', err);
		return false;
	}
	if (!verification.verified) return false;

	const { credential, credentialBackedUp } = verification.registrationInfo;

	if (await credentialOwnedByOtherUser(db, credential.id, user.id)) return false;

	// Client-supplied and replayed to the authenticator, so keep it to the transports WebAuthn defines.
	const transports = (credential.transports ?? []).filter((t) => TRANSPORTS.has(t)).slice(0, 6);

	// Upsert: the same device registering again replaces its own row instead of failing the index.
	await db
		.insert(passkeys)
		.values({
			userId: user.id,
			credentialId: credential.id,
			publicKey: isoBase64URL.fromBuffer(credential.publicKey),
			counter: credential.counter,
			transports: transports.length ? transports : null,
			name,
			backedUp: credentialBackedUp
		})
		.onConflictDoUpdate({
			target: passkeys.credentialId,
			set: {
				publicKey: isoBase64URL.fromBuffer(credential.publicKey),
				counter: credential.counter,
				transports: transports.length ? transports : null,
				name,
				backedUp: credentialBackedUp
			}
		});
	return true;
}

/** No `allowCredentials`: the browser offers the discoverable credentials it holds for this host. */
export async function startAuthentication(
	db: Db,
	url: URL,
	opts: CeremonyOpts = {}
): Promise<PasskeyOptions<PublicKeyCredentialRequestOptionsJSON> | null> {
	if ((await supersedeAndThrottle(db, opts)).throttled) return null;

	const options = await generateAuthenticationOptions({
		...relyingParty(url),
		userVerification: 'required'
	});
	return {
		options,
		challengeId: await storeChallenge(db, options.challenge, 'anonymous', {
			rpId: url.hostname,
			ip: opts.ip
		})
	};
}

export type PasskeySignInResult =
	{ ok: true; user: User } | { ok: false; reason: 'invalid' | 'not_allowed' };

/** The credential identifies its owner, so a combined `user_handle` sent by the browser is never trusted. */
export async function finishAuthentication(opts: {
	db: Db;
	url: URL;
	challengeId: string | undefined;
	response: AuthenticationResponseJSON;
}): Promise<PasskeySignInResult> {
	const { db, url, challengeId, response } = opts;
	const challenge = await takeChallenge(db, challengeId, 'anonymous', url.hostname);
	if (!challenge) return { ok: false, reason: 'invalid' };

	const rows = await db
		.select({ passkey: passkeys, user: users })
		.from(passkeys)
		.innerJoin(users, eq(passkeys.userId, users.id))
		.where(eq(passkeys.credentialId, response.id))
		.limit(1);
	const row = rows.at(0);
	if (!row) return { ok: false, reason: 'invalid' };

	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: url.origin,
			expectedRPID: url.hostname,
			credential: {
				id: row.passkey.credentialId,
				publicKey: isoBase64URL.toBuffer(row.passkey.publicKey),
				counter: row.passkey.counter,
				transports: row.passkey.transports ?? undefined
			},
			requireUserVerification: true
		});
	} catch (err) {
		console.error('passkey sign-in failed:', err);
		return { ok: false, reason: 'invalid' };
	}
	if (!verification.verified) return { ok: false, reason: 'invalid' };

	const { newCounter, credentialBackedUp } = verification.authenticationInfo;
	await db
		.update(passkeys)
		.set({ counter: newCounter, backedUp: credentialBackedUp, lastUsedAt: new Date() })
		.where(eq(passkeys.id, row.passkey.id));

	// A passkey outliving a block/disable must not become a way in.
	if (row.user.status !== 'enabled') return { ok: false, reason: 'not_allowed' };
	return { ok: true, user: row.user };
}

export interface PasskeySummary {
	id: string;
	name: string;
	backedUp: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

export async function listPasskeys(db: Db, userId: string): Promise<PasskeySummary[]> {
	const rows = await db
		.select({
			id: passkeys.id,
			name: passkeys.name,
			backedUp: passkeys.backedUp,
			createdAt: passkeys.createdAt,
			lastUsedAt: passkeys.lastUsedAt
		})
		.from(passkeys)
		.where(eq(passkeys.userId, userId))
		.orderBy(passkeys.createdAt);
	return rows.map((row) => ({
		...row,
		createdAt: row.createdAt.getTime(),
		lastUsedAt: row.lastUsedAt?.getTime() ?? null
	}));
}

/** Scoped by user, so one account can never delete another's credential. */
export async function removePasskey(db: Db, userId: string, id: string): Promise<boolean> {
	const deleted = await db
		.delete(passkeys)
		.where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
		.returning({ id: passkeys.id });
	return deleted.length > 0;
}

export type { Passkey };
