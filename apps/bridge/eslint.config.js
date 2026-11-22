import js from '@eslint/js';
import path from 'node:path';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import ts from 'typescript-eslint';

// The single .gitignore lives at the workspace root; its patterns are path-agnostic, so it applies here.
const gitignorePath = path.resolve(import.meta.dirname, '../../.gitignore');

// No svelte plugin here: this package is plain TypeScript on the Workers runtime.
export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	prettier,
	{
		languageOptions: { globals: { ...globals.worker, ...globals.node } },
		rules: {
			// typescript-eslint's own guidance: `no-undef` duplicates what tsc already checks.
			'no-undef': 'off'
		}
	}
);
