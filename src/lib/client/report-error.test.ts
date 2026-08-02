import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobalErrorReporting, type ClientErrorReport } from './report-error';

/** Dispatch an event carrying the extra fields the browser puts on error events. */
function fire(target: EventTarget, type: string, fields: Record<string, unknown>) {
	target.dispatchEvent(Object.assign(new Event(type), fields));
}

describe('installGlobalErrorReporting', () => {
	let target: EventTarget;
	let reports: ClientErrorReport[];
	let report: (r: ClientErrorReport) => void;
	// The install guard is module-global (one app, one install), so each test must tear down.
	let teardown: (() => void)[];

	function install(options: { report?: (r: ClientErrorReport) => void } = {}) {
		const uninstall = installGlobalErrorReporting({
			target,
			report: options.report ?? report
		});
		teardown.push(uninstall);
		return uninstall;
	}

	beforeEach(() => {
		target = new EventTarget();
		reports = [];
		teardown = [];
		report = (r) => reports.push(r);
	});

	afterEach(() => {
		for (const t of teardown) t();
	});

	it('reports an uncaught error with its stack and location', () => {
		install();
		const error = new Error('kaboom');
		fire(target, 'error', { message: 'Uncaught Error: kaboom', error, filename: 'app.js' });

		expect(reports).toHaveLength(1);
		expect(reports[0].message).toBe('kaboom');
		expect(reports[0].stack).toBe(error.stack);
		expect(reports[0].source).toBe('window.error');
	});

	it('reports an unhandled promise rejection', () => {
		install();
		fire(target, 'unhandledrejection', { reason: new Error('never caught') });

		expect(reports).toHaveLength(1);
		expect(reports[0].message).toBe('never caught');
		expect(reports[0].source).toBe('unhandledrejection');
	});

	it('reports a rejection whose reason is not an Error', () => {
		install();
		fire(target, 'unhandledrejection', { reason: 'just a string' });

		expect(reports[0].message).toBe('just a string');
	});

	it('falls back to the event message when no error object is attached', () => {
		install();
		fire(target, 'error', { message: 'Script error.' });

		expect(reports[0].message).toBe('Script error.');
	});

	it('ignores resource load failures, which carry no error and no message', () => {
		install();
		fire(target, 'error', {});

		expect(reports).toHaveLength(0);
	});

	it('collapses a repeating error so a loop cannot flood the sink', () => {
		install();
		for (let i = 0; i < 50; i++) fire(target, 'error', { message: 'same every time' });

		expect(reports).toHaveLength(1);
	});

	it('still reports a different error after a repeat was collapsed', () => {
		install();
		fire(target, 'error', { message: 'first' });
		fire(target, 'error', { message: 'first' });
		fire(target, 'error', { message: 'second' });

		expect(reports.map((r) => r.message)).toEqual(['first', 'second']);
	});

	it('caps how many reports one page load can send', () => {
		install();
		for (let i = 0; i < 100; i++) fire(target, 'error', { message: `distinct ${i}` });

		expect(reports.length).toBeLessThanOrEqual(20);
		expect(reports.length).toBeGreaterThan(0);
	});

	it('never throws when the reporter itself fails', () => {
		install({
			report: () => {
				throw new Error('sink is down');
			}
		});

		expect(() => fire(target, 'error', { message: 'boom' })).not.toThrow();
	});

	it('stops reporting once uninstalled', () => {
		const uninstall = install();
		uninstall();
		fire(target, 'error', { message: 'after teardown' });

		expect(reports).toHaveLength(0);
	});

	it('installs only once even if called again', () => {
		install();
		install(); // e.g. a hot reload re-running app startup
		fire(target, 'error', { message: 'once please' });

		// One listener set, so one report — not a duplicate per install.
		expect(reports).toHaveLength(1);
	});
});

describe('reportClientError', () => {
	it('posts the report to the sink and swallows a failed post', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
		vi.stubGlobal('fetch', fetchMock);
		const { reportClientError } = await import('./report-error');

		expect(() => reportClientError({ message: 'x', source: 'test' })).not.toThrow();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/client-error',
			expect.objectContaining({
				method: 'POST'
			})
		);
		vi.unstubAllGlobals();
	});
});
