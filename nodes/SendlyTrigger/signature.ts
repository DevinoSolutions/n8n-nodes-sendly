import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Sendly signs every webhook delivery with Standard Webhooks headers: `webhook-id`,
 * `webhook-timestamp` (unix seconds) and `webhook-signature`, a space-separated list of
 * `v1,<base64 HMAC-SHA256(key, "id.timestamp.body")>`. During a secret rotation it carries one
 * signature per active secret, so any match passes.
 */

/**
 * The key bytes a secret signs with: a `whsec_<base64>` secret signs with the decoded bytes, an
 * older secret with its UTF-8 bytes.
 */
export function signingKey(secret: string): Buffer {
	return secret.startsWith('whsec_')
		? Buffer.from(secret.slice('whsec_'.length), 'base64')
		: Buffer.from(secret, 'utf8');
}

export function computeSignature(
	secret: string,
	id: string,
	timestamp: string,
	body: string,
): string {
	return createHmac('sha256', signingKey(secret))
		.update(`${id}.${timestamp}.${body}`)
		.digest('base64');
}

export function signatureMatches(options: {
	secret: string;
	id: string;
	timestamp: string;
	body: string;
	signatureHeader: string;
}): boolean {
	const { secret, id, timestamp, body, signatureHeader } = options;
	const expected = Buffer.from(computeSignature(secret, id, timestamp, body), 'base64');
	return signatureHeader
		.split(' ')
		.filter((candidate) => candidate.length > 0)
		.some((candidate) => {
			const [version, encoded] = candidate.split(',', 2);
			if (version !== 'v1' || !encoded) return false;
			const given = Buffer.from(encoded, 'base64');
			return given.length === expected.length && timingSafeEqual(given, expected);
		});
}

/** How far a delivery's signed `webhook-timestamp` may be from now, either way (seconds). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Whether a signed `webhook-timestamp` (unix seconds) is within the tolerance of `nowMs`. The
 * Standard Webhooks replay guard: the timestamp is part of what is signed, so an attacker who
 * captured a delivery cannot move it forward.
 */
export function timestampIsFresh(timestamp: string, nowMs: number = Date.now()): boolean {
	if (!/^\d{1,12}$/.test(timestamp)) return false;
	return Math.abs(nowMs / 1000 - Number(timestamp)) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/** Header lookup that ignores case, for any header map n8n hands over. */
export function readHeader(
	headers: Record<string, string | string[] | undefined> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) {
			return Array.isArray(value) ? value[0] : value;
		}
	}
	return undefined;
}
