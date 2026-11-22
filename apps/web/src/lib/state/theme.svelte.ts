type ThemeMode = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'marquee:theme-mode';

function getSystemDark(): boolean {
	if (typeof window === 'undefined') return true;
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getStoredMode(): ThemeMode {
	if (typeof window === 'undefined') return 'auto';
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
	return 'auto';
}

class ThemeState {
	mode = $state<ThemeMode>(getStoredMode());
	isDark = $derived(this.mode === 'auto' ? getSystemDark() : this.mode === 'dark');

	set(mode: ThemeMode) {
		this.mode = mode;
		if (typeof window !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, mode);
		}
	}
}

export const theme = new ThemeState();
