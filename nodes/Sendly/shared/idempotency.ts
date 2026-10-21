import { createHash, randomUUID } from 'crypto';
import { sleep } from 'n8n-workflow';
import type { SendlyResponse } from './transport';

/** The API's bound on `Idempotency-Key` (1 to 255 characters). */
const MAX_KEY_LENGTH = 255;

/** Visible ASCII and spaces: what an HTTP header value can carry as-is. */
const HEADER_SAFE = /^[\x20-\x7e]+$/;

/**
 * The `Idempotency-Key` for a transactional send. A key the user mapped (say, the order ID of
 * the item that triggered the workflow) makes a re-run of the same item safe: Sendly replays the
 * first receipt for 24 hours instead of sending again. Without one, every execution gets a fresh
 * key: that still makes the one retry below safe, and it never merges two genuinely identical
 * emails into one, which a key derived from the body would.
 */
export function sendIdempotencyKey(userKey: unknown): string {
	if (typeof userKey === 'string' && userKey.trim() !== '') {
		// Namespaced: the ledger is per project, so a bare order ID could collide with a key the
		// customer's own backend sends for another request. A value that is too long or not
		// printable ASCII would make the request throw, so it is hashed instead.
		const key = `n8n-send:${userKey.trim()}`;
		return key.length <= MAX_KEY_LENGTH && HEADER_SAFE.test(key)
			? key
			: `n8n-send:${createHash('sha256').update(key).digest('hex')}`;
	}
	return `n8n-${randomUUID()}`;
}

/** A key that is the same for every run with the same parts. */
export function derivedIdempotencyKey(...parts: string[]): string {
	return `n8n-${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}

/**
 * Worth sending again with the same key: a 5xx, or 409 (the first request under this key is
 * still in flight). The server replays the first request's result or runs it once, never twice.
 */
export function isRetryable(response: SendlyResponse): boolean {
	return response.statusCode >= 500 || response.statusCode === 409;
}

/** Pause before the single retry. Exported so tests can shorten it. */
export const retrySettings = { delayMs: 1500 };

/**
 * Runs `send` and, once, again after a short pause when the first answer is retryable. Both
 * attempts carry the caller's single idempotency key.
 */
export async function sendWithOneRetry<T>(
	send: () => Promise<SendlyResponse<T>>,
): Promise<SendlyResponse<T>> {
	const first = await send();
	if (!isRetryable(first as SendlyResponse)) return first;
	await sleep(retrySettings.delayMs);
	return await send();
}
