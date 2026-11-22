import type { createDb } from '#lib/server/db/index.js';
import { adminAudit } from '#lib/server/db/schema.js';

type Db = ReturnType<typeof createDb>;

export const AUDIT_ACTIONS = [
	'user.enable',
	'user.block',
	'user.unblock',
	'user.delete',
	'user.restore',
	'user.purge',
	'media.block',
	'media.unblock',
	'media.delete'
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
	actor: { id: string; email: string };
	action: AuditAction;
	target: { type: string; id: string; label?: string | null };
	reason?: string | null;
	metadata?: Record<string, unknown> | null;
	ip?: string | null;
}

// Returns the insert so callers can batch it with the mutation: the change and its audit row commit together.
export function auditStatement(db: Db, entry: AuditEntry) {
	return db.insert(adminAudit).values({
		actorUserId: entry.actor.id,
		actorEmail: entry.actor.email,
		action: entry.action,
		targetType: entry.target.type,
		targetId: entry.target.id,
		targetLabel: entry.target.label ?? null,
		reason: entry.reason ?? null,
		metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
		ip: entry.ip ?? null
	});
}
