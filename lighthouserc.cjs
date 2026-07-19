/**
 * Lighthouse CI config (MRQ-102) — warn-only PWA/Core-Web-Vitals gate.
 *
 * CommonJS (.cjs) so it stays CommonJS under the repo's "type": "module" and can
 * carry these comments.
 *
 * WARN-ONLY on purpose: every assertion below is `warn`, so a threshold miss shows
 * up on the PR but never blocks a merge. Thresholds are intentionally loose for now
 * and will be tightened (and eventually promoted to `error`) in a follow-up.
 *
 * PWA / installability note: Lighthouse 12 (bundled in @lhci/cli >= 0.14) REMOVED
 * the entire PWA category and its installability audits (installable-manifest,
 * maskable-icon, themed-omnibox, splash-screen, ...). Passing `pwa` in
 * onlyCategories now errors with "unrecognized category", so this config cannot
 * assert installability on current Lighthouse. We assert Best Practices + Core Web
 * Vitals instead. Revisit if/when Lighthouse restores a manifest/installability
 * audit (or add a standalone manifest check).
 */
module.exports = {
	ci: {
		collect: {
			// Serve the built Cloudflare Worker via `pnpm preview` (= `wrangler dev`,
			// local mode — no Cloudflare account needed). This is the only option that
			// renders the real SSR homepage; @lhci/cli's `staticDistDir` can't, because
			// the app is SSR and there is no prerendered index.html. The `/` route has
			// no DB-dependent load for anonymous requests, so wrangler dev serves a
			// clean 200 without migrations or secrets.
			startServerCommand: 'pnpm preview',
			// wrangler v4 prints "Ready on http://localhost:8787" once the worker is up.
			startServerReadyPattern: 'Ready on',
			startServerReadyTimeout: 120000, // first run downloads workerd
			url: ['http://localhost:8787/'],
			numberOfRuns: 3, // median of 3 smooths out CWV run-to-run noise
			settings: {
				// Chrome runs as a sandboxed-unfriendly user in CI containers.
				chromeFlags: '--no-sandbox'
			}
		},
		assert: {
			assertions: {
				// Overall best-practices score (closest proxy left for general page health).
				'categories:best-practices': ['warn', { minScore: 0.9 }],
				// Core Web Vitals (lab). Budgets are the "good" field thresholds.
				'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }], // LCP (ms)
				'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }], // CLS
				// INP is a field-only metric and isn't measurable in lab navigation mode;
				// Total Blocking Time is Lighthouse's lab proxy for interaction latency.
				'total-blocking-time': ['warn', { maxNumericValue: 200 }] // TBT (ms) ~ INP proxy
			}
		},
		upload: {
			// Public (unlisted) report URL so the Lighthouse CI GitHub App can post a
			// PR status check that links to the full report. Reports live in a
			// Google-hosted bucket; the only audited page is the public login/landing.
			target: 'temporary-public-storage'
		}
	}
};
