// Print a Markdown coverage table (for GitHub Actions job summary) from the
// v8 json-summary report. No-op if the report is missing.
import { readFileSync } from 'node:fs';

try {
	const { total } = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
	const lines = [
		'### Test coverage',
		'',
		'| Metric | Coverage |',
		'| --- | --- |',
		...['statements', 'branches', 'functions', 'lines'].map(
			(k) => `| ${k} | ${total[k].pct}% (${total[k].covered}/${total[k].total}) |`
		)
	];
	console.log(lines.join('\n'));
} catch {
	console.log('_No coverage report found._');
}
