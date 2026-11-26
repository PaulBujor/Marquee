/** The slice of `KVNamespace` the bridge uses, over a Map. */
export function memoryKv(initial: Record<string, string> = {}): KVNamespace {
	const store = new Map(Object.entries(initial));

	// SAFETY: the bridge only calls get(key), get(key, 'json'), put(key, value) and delete(key) —
	// the four members implemented below. The rest of KVNamespace is never reached from src/.
	return {
		get: async (key: string, type?: string) => {
			const value = store.get(key) ?? null;
			return value !== null && type === 'json' ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		}
	} as unknown as KVNamespace;
}
