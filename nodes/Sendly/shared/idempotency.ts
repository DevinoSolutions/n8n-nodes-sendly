import { createHash, randomUUID } from 'crypto';
import { sleep } from 'n8n-workflow';
import type { SendlyResponse } from './transport';

/** The API's bound on `Idempotency-Key` (1 to 255 characters). */
const MAX_KEY_LENGTH = 255;

/** Visible ASCII and spaces: what an HTTP header value can carry as-is. */
const HEADER_SAFE = /^[\x20-\x7e]+$/;

/**
 * Where one send sits inside n8n: the instance, workflow, execution, node, run of that node and
 * input item. n8n's "Retry On Fail" re-runs a failed node inside the same execution, with the
 * same run index and the same items, so every part stays the same across those tries. A loop
 * (or an AI Agent calling the node as a tool) runs the node again with a new run index, and a
 * manual "Retry" of a failed execution starts a new execution with a new ID.
 */
export interface SendPosition {
	instanceId?: string;
	workflowId?: string;
	executionId?: string;
	nodeName: string;
	runIndex: number;
	itemIndex: number;
}

/**
 * The `Idempotency-Key` for a transactional send.
 *
 * A key the user mapped (say, the order ID of the item that triggered the workflow) is used
 * as-is, namespaced: Sendly replays the first receipt for 24 hours instead of sending again, in
 * this execution or any other.
 *
 * Without one, the key is derived from the send's position in the execution, so n8n's Retry On
 * Fail, which re-runs the whole node with every item, replays the receipts of the items that were
 * already sent instead of sending them again. It never merges two different sends: each item,
 * each run of the node and each execution gets its own key. When n8n gives no execution ID, the
 * key is random, which still covers the single retry below.
 */
export function sendIdempotencyKey(userKey: unknown, position: SendPosition): string {
	if (typeof userKey === 'string' && userKey.trim() !== '') {
		// Namespaced: the ledger is per project, so a bare order ID could collide with a key the
		// customer's own backend sends for another request. A value that is too long or not
		// printable ASCII would make the request throw, so it is hashed instead.
		const key = `n8n-send:${userKey.trim()}`;
		return key.length <= MAX_KEY_LENGTH && HEADER_SAFE.test(key)
			? key
			: `n8n-send:${createHash('sha256').update(key).digest('hex')}`;
	}
	if (!position.executionId) return `n8n-${randomUUID()}`;
	return `n8n-run:${digest([
		'email-send',
		position.instanceId ?? '',
		position.workflowId ?? '',
		position.executionId,
		position.nodeName,
		String(position.runIndex),
		String(position.itemIndex),
	])}`;
}

/** A key that is the same for every run with the same parts. */
export function derivedIdempotencyKey(...parts: string[]): string {
	return `n8n-${digest(parts)}`;
}

function digest(parts: string[]): string {
	return createHash('sha256').update(parts.join('\n')).digest('hex');
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
 * Runs `send` and, once, again after a short pause when the first answer is retryable or the
 * request failed without an answer (a reset connection or a timeout, where the first request may
 * or may not have reached Sendly). Both attempts carry the caller's single idempotency key, so
 * the server sends at most once. A second failure is returned or thrown as it is.
 */
export async function sendWithOneRetry<T>(
	send: () => Promise<SendlyResponse<T>>,
): Promise<SendlyResponse<T>> {
	let first: SendlyResponse<T> | undefined;
	try {
		first = await send();
	} catch {
		// No answer: fall through to the retry below.
	}
	if (first !== undefined && !isRetryable(first as SendlyResponse)) return first;
	await sleep(retrySettings.delayMs);
	return await send();
}
