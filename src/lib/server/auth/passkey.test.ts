import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { createTestDb } from '#lib/server/db/test-db.js';
import { passkeyChallenges, passkeys, users } from '#lib/server/db/schema.js';
import {
	credentialOwnedByOtherUser,
	finishAuthentication,
	finishRegistration,
	isRecentSignIn,
	listPasskeys,
	REAUTH_WINDOW_MS,
	removePasskey,
	requireRecentSignIn,
	startAuthentication,
	startRegistration
} from './passkey';

type Db = ReturnType<typeof createTestDb>;

let db: Db;
const ORIGIN = 'https://marquee.test';
const RP_ID = 'marquee.test';
const url = new URL(`${ORIGIN}/login`);
const encoder = new TextEncoder();

/** These are nullable only because the per-client ceremony cap can refuse them. */
function unwrap<T>(value: T | null): T {
	expect(value).not.toBeNull();
	return value as T;
}

const b64url = (bytes: Uint8Array | ArrayBuffer): string =>
	Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

/** Authenticators send ES256 assertions ASN.1 DER-encoded; WebCrypto hands back raw r||s. */
function toDerSignature(raw: Uint8Array): Buffer {
	const trim = (bytes: Uint8Array) => {
		let i = 0;
		while (i < bytes.length - 1 && bytes[i] === 0) i++;
		return Buffer.from(bytes.subarray(i));
	};
	const int = (bytes: Buffer) =>
		Buffer.concat([
			Buffer.from([0x02, bytes.length + (bytes[0] & 0x80 ? 1 : 0)]),
			bytes[0] & 0x80 ? Buffer.from([0]) : Buffer.alloc(0),
			bytes
		]);
	const body = Buffer.concat([int(trim(raw.subarray(0, 32))), int(trim(raw.subarray(32, 64)))]);
	return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

beforeEach(() => {
	db = createTestDb();
});

async function seedUser(email = 'user@example.com', status: 'enabled' | 'pending' = 'enabled') {
	const [row] = await db.insert(users).values({ email, status }).returning();
	return row;
}

/** A P-256 keypair plus the COSE public key an authenticator would register for it. */
async function newCredential() {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign'
	]);
	const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
	// COSE_Key as CBOR: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
	const cose = Buffer.concat([
		Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
		Buffer.from(jwk.x ?? '', 'base64url'),
		Buffer.from([0x22, 0x58, 0x20]),
		Buffer.from(jwk.y ?? '', 'base64url')
	]);
	return {
		credentialId: `cred-${crypto.randomUUID()}`,
		publicKey: cose.toString('base64url'),
		privateKey: pair.privateKey
	};
}

/** A real assertion: authenticatorData || SHA-256(clientDataJSON), signed with ES256. */
async function assertion(opts: {
	privateKey: CryptoKey;
	credentialId: string;
	challenge: string;
	counter?: number;
}): Promise<AuthenticationResponseJSON> {
	const clientDataBytes = encoder.encode(
		JSON.stringify({
			type: 'webauthn.get',
			challenge: opts.challenge,
			origin: ORIGIN,
			crossOrigin: false
		})
	);
	const clientDataHash = new Uint8Array(
		await crypto.subtle.digest('SHA-256', clientDataBytes as unknown as BufferSource)
	);
	const counter = new Uint8Array(4);
	new DataView(counter.buffer).setUint32(0, opts.counter ?? 0);
	const authenticatorData = Buffer.concat([
		Buffer.from(await crypto.subtle.digest('SHA-256', encoder.encode(RP_ID))),
		Buffer.from([0x05]), // flags: user present | user verified
		counter
	]);
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		opts.privateKey,
		Buffer.concat([authenticatorData, clientDataHash])
	);

	return {
		id: opts.credentialId,
		rawId: opts.credentialId,
		type: 'public-key',
		clientExtensionResults: {},
		response: {
			clientDataJSON: b64url(clientDataBytes),
			authenticatorData: b64url(authenticatorData),
			signature: b64url(toDerSignature(new Uint8Array(signature)))
		}
	};
}

async function registerPasskey(userId: string) {
	const credential = await newCredential();
	await db.insert(passkeys).values({
		userId,
		credentialId: credential.credentialId,
		publicKey: credential.publicKey,
		name: 'Test device'
	});
	return credential;
}

describe('passkey sign-in', () => {
	it('verifies a signed assertion and records the counter and last use', async () => {
		const user = await seedUser();
		const credential = await registerPasskey(user.id);

		const { options, challengeId } = unwrap(await startAuthentication(db, url));
		const result = await finishAuthentication({
			db,
			url,
			challengeId,
			response: await assertion({ ...credential, challenge: options.challenge, counter: 7 })
		});

		expect(result).toMatchObject({ ok: true, user: { id: user.id } });
		const [stored] = await db.select().from(passkeys);
		expect(stored.counter).toBe(7);
		expect(stored.lastUsedAt).not.toBeNull();
	});

	it('answers a usernameless challenge, so no email is needed to start', async () => {
		const { options } = unwrap(await startAuthentication(db, url));
		expect(options.rpId).toBe(RP_ID);
		expect(options.allowCredentials ?? []).toHaveLength(0);
		expect(options.userVerification).toBe('required');
	});

	it('refuses a replayed ceremony', async () => {
		const user = await seedUser();
		const credential = await registerPasskey(user.id);

		const { options, challengeId } = unwrap(await startAuthentication(db, url));
		const response = await assertion({ ...credential, challenge: options.challenge });

		expect((await finishAuthentication({ db, url, challengeId, response })).ok).toBe(true);
		expect(await finishAuthentication({ db, url, challengeId, response })).toEqual({
			ok: false,
			reason: 'invalid'
		});
	});

	it('refuses a stale challenge', async () => {
		const user = await seedUser();
		const credential = await registerPasskey(user.id);
		const { options, challengeId } = unwrap(await startAuthentication(db, url));
		await db
			.update(passkeyChallenges)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(passkeyChallenges.id, challengeId));

		const result = await finishAuthentication({
			db,
			url,
			challengeId,
			response: await assertion({ ...credential, challenge: options.challenge })
		});
		expect(result).toEqual({ ok: false, reason: 'invalid' });
	});

	it('refuses a signature from the wrong key', async () => {
		const user = await seedUser();
		const credential = await registerPasskey(user.id);
		const impostor = await newCredential();
		const { options, challengeId } = unwrap(await startAuthentication(db, url));

		const result = await finishAuthentication({
			db,
			url,
			challengeId,
			response: await assertion({
				privateKey: impostor.privateKey,
				credentialId: credential.credentialId,
				challenge: options.challenge
			})
		});
		expect(result).toEqual({ ok: false, reason: 'invalid' });
	});

	it('refuses an unknown credential', async () => {
		const credential = await newCredential();
		const { options, challengeId } = unwrap(await startAuthentication(db, url));

		const result = await finishAuthentication({
			db,
			url,
			challengeId,
			response: await assertion({ ...credential, challenge: options.challenge })
		});
		expect(result).toEqual({ ok: false, reason: 'invalid' });
	});

	it("refuses a user who isn't enabled", async () => {
		const user = await seedUser('pending@example.com', 'pending');
		const credential = await registerPasskey(user.id);
		const { options, challengeId } = unwrap(await startAuthentication(db, url));

		const result = await finishAuthentication({
			db,
			url,
			challengeId,
			response: await assertion({ ...credential, challenge: options.challenge })
		});
		expect(result).toEqual({ ok: false, reason: 'not_allowed' });
		// Rejected before any write, so a blocked user's assertion leaves no trace on the credential.
		expect((await db.select().from(passkeys))[0].lastUsedAt).toBeNull();
	});
});

describe('passkey registration', () => {
	it('binds the challenge to the user and consumes it once', async () => {
		const user = await seedUser();
		const other = await seedUser('other@example.com');
		const { challengeId } = unwrap(await startRegistration(db, user, url));

		const [row] = await db
			.select()
			.from(passkeyChallenges)
			.where(eq(passkeyChallenges.id, challengeId));
		expect(row.userId).toBe(user.id);

		// Registering under someone else's challenge id does nothing, and doesn't burn it either.
		const rejected = await finishRegistration({
			db,
			user: other,
			url,
			challengeId,
			response: {} as never,
			name: 'nope'
		});
		expect(rejected).toBe(false);
		expect(await db.select().from(passkeys)).toHaveLength(0);

		const garbage = await finishRegistration({
			db,
			user,
			url,
			challengeId,
			response: {} as never,
			name: 'nope'
		});
		expect(garbage).toBe(false);
		// Single use: the failed attempt consumed it.
		expect(await db.select().from(passkeyChallenges)).toHaveLength(0);
	});

	it('excludes credentials the user already has', async () => {
		const user = await seedUser();
		const credential = await registerPasskey(user.id);

		const { options } = unwrap(await startRegistration(db, user, url));
		expect(options.excludeCredentials?.map((c) => c.id)).toEqual([credential.credentialId]);
		expect(options.rp.id).toBe(RP_ID);
	});

	it('fails without a challenge cookie', async () => {
		const user = await seedUser();
		expect(
			await finishRegistration({
				db,
				user,
				url,
				challengeId: undefined,
				response: {} as never,
				name: 'nope'
			})
		).toBe(false);
	});
});

describe('passkey management', () => {
	it('lists only the caller’s passkeys', async () => {
		const user = await seedUser();
		const other = await seedUser('other@example.com');
		await registerPasskey(user.id);
		await registerPasskey(other.id);

		const listed = await listPasskeys(db, user.id);
		expect(listed).toHaveLength(1);
		expect(listed[0].name).toBe('Test device');
	});

	it('never deletes another account’s passkey', async () => {
		const user = await seedUser();
		const other = await seedUser('other@example.com');
		await registerPasskey(other.id);
		const [target] = await db.select().from(passkeys);

		expect(await removePasskey(db, user.id, target.id)).toBe(false);
		expect(await db.select().from(passkeys)).toHaveLength(1);
		expect(await removePasskey(db, other.id, target.id)).toBe(true);
		expect(await db.select().from(passkeys)).toHaveLength(0);
	});
});

describe('hardening', () => {
	it('replaces this browser’s previous challenge instead of accumulating rows', async () => {
		const first = unwrap(await startAuthentication(db, url, { ip: '1.2.3.4' }));
		unwrap(
			await startAuthentication(db, url, {
				ip: '1.2.3.4',
				previousChallengeId: first.challengeId
			})
		);
		expect(await db.select().from(passkeyChallenges)).toHaveLength(1);
	});

	it('caps the ceremonies one client can leave open', async () => {
		for (let i = 0; i < 10; i++) unwrap(await startAuthentication(db, url, { ip: '9.9.9.9' }));

		expect(await startAuthentication(db, url, { ip: '9.9.9.9' })).toBeNull();
		// The cap is per client, so it can't be used to lock everyone else out.
		expect(await startAuthentication(db, url, { ip: '8.8.8.8' })).not.toBeNull();
	});

	it('will not complete a challenge minted for another host', async () => {
		const user = await seedUser();
		const credential = await registerPasskey(user.id);
		const started = unwrap(await startAuthentication(db, url));

		const result = await finishAuthentication({
			db,
			url: new URL('https://elsewhere.test/login'),
			challengeId: started.challengeId,
			response: await assertion({ ...credential, challenge: started.options.challenge })
		});
		expect(result).toEqual({ ok: false, reason: 'invalid' });
	});

	it('never supersedes a challenge belonging to another owner', async () => {
		const user = await seedUser();
		const enrolled = unwrap(await startRegistration(db, user, url));
		const anonymous = unwrap(await startAuthentication(db, url));

		// A caller-supplied cookie id must not delete the other owner's row in either direction.
		unwrap(await startAuthentication(db, url, { previousChallengeId: enrolled.challengeId }));
		unwrap(await startRegistration(db, user, url, { previousChallengeId: anonymous.challengeId }));

		const ids = (await db.select().from(passkeyChallenges)).map((row) => row.id);
		expect(ids).toEqual(expect.arrayContaining([enrolled.challengeId, anonymous.challengeId]));
	});

	it('replaces the same user’s previous enrolment challenge', async () => {
		const user = await seedUser();
		const first = unwrap(await startRegistration(db, user, url));
		unwrap(await startRegistration(db, user, url, { previousChallengeId: first.challengeId }));
		expect(await db.select().from(passkeyChallenges)).toHaveLength(1);
	});

	it('flags a credential that already belongs to another account', async () => {
		const owner = await seedUser();
		const other = await seedUser('other@example.com');
		const credential = await registerPasskey(owner.id);

		expect(await credentialOwnedByOtherUser(db, credential.credentialId, other.id)).toBe(true);
		expect(await credentialOwnedByOtherUser(db, credential.credentialId, owner.id)).toBe(false);
		expect(await credentialOwnedByOtherUser(db, 'unknown-id', owner.id)).toBe(false);
	});
});

describe('recent sign-in gate', () => {
	it('allows a sign-in inside the window and refuses one past it', () => {
		const now = Date.now();
		expect(isRecentSignIn({ createdAt: new Date(now - 60_000) }, now)).toBe(true);
		expect(isRecentSignIn({ createdAt: new Date(now - REAUTH_WINDOW_MS) }, now)).toBe(true);
		expect(isRecentSignIn({ createdAt: new Date(now - REAUTH_WINDOW_MS - 1) }, now)).toBe(false);
	});

	it('refuses a credential change without a recent session', () => {
		const now = Date.now();
		expect(requireRecentSignIn({ session: null })?.status).toBe(403);
		expect(
			requireRecentSignIn({ session: { createdAt: new Date(now - REAUTH_WINDOW_MS - 1) } })?.status
		).toBe(403);
		expect(requireRecentSignIn({ session: { createdAt: new Date(now) } })).toBeNull();
	});
});
