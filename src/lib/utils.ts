import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Focus an input on mount. Pass an `<input>` (focuses it) or a container (focuses the
 * first `<input>` inside — e.g. an OTP root). Use from an `$effect` bound to a component `ref`;
 * this avoids the static `autofocus` attribute (and its a11y-lint warning) while giving the same UX.
 */
export function focusFirstInput(el: HTMLElement | null | undefined): void {
	if (!el) return;
	const target = el instanceof HTMLInputElement ? el : el.querySelector('input');
	target?.focus();
}

export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;

export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
