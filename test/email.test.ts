import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { Sendly } from '../nodes/Sendly/Sendly.node';
import {
	executeContext,
	locator,
	MockHttp,
	rejection,
	type ExecutionPosition,
} from './helpers';

const node = new Sendly();
const TEMPLATE_ID = '5d6e7f80-9a1b-4c2d-8e3f-405162738495';
const RECEIPT = { id: 'e1', status: 'PENDING', to: 'ada@example.com', from: 'hello@acme.dev' };

function sendParams(overrides: IDataObject = {}): IDataObject {
	return {
		resource: 'email',
		operation: 'send',
		to: 'ada@example.com',
		content: 'template',
		template: locator(TEMPLATE_ID),
		additionalFields: {},
		...overrides,
	};
}

async function run(
	params: IDataObject[],
	http: MockHttp,
	continueOnFail = false,
	position?: ExecutionPosition,
) {
	return await node.execute.call(executeContext(params, http, { continueOnFail, position }));
}

function keys(http: MockHttp): string[] {
	return http.calls.map((call) => String(call.headers['Idempotency-Key']));
}

function receipts(count: number) {
	return Array.from({ length: count }, () => ({ statusCode: 202, body: RECEIPT }));
}

describe('Email > Send', () => {
	it('POSTs a template send to /api/v1/emails and returns the receipt', async () => {
		const http = new MockHttp([{ statusCode: 202, body: RECEIPT }]);
		const [[item]] = await run([sendParams()], http);

		assert.deepEqual(item.json, RECEIPT);
		assert.deepEqual(item.pairedItem, { item: 0 });
		const [call] = http.calls;
		assert.strictEqual(call.credentialName, 'sendlyApi');
		assert.strictEqual(call.method, 'POST');
		assert.strictEqual(call.url, 'https://api.sendly.now/api/v1/emails');
		assert.deepEqual(call.body, { to: 'ada@example.com', template: TEMPLATE_ID });
	});

	it('derives a distinct Idempotency-Key per item from the execution when no Deduplication Key is set', async () => {
		const http = new MockHttp(receipts(2));
		await run([sendParams(), sendParams()], http);
		const [first, second] = keys(http);
		assert.match(first, /^n8n-run:[0-9a-f]{64}$/);
		assert.match(second, /^n8n-run:[0-9a-f]{64}$/);
		assert.notStrictEqual(first, second);
	});

	it('keeps every item key when the node is re-run in the same execution (Retry On Fail), so sent items are replayed, not resent', async () => {
		const items = [sendParams(), sendParams(), sendParams()];
		const firstTry = new MockHttp(receipts(3));
		await run(items, firstTry, false, { executionId: '1001', runIndex: 0 });
		const secondTry = new MockHttp(receipts(3));
		await run(items, secondTry, false, { executionId: '1001', runIndex: 0 });
		assert.deepEqual(keys(secondTry), keys(firstTry));
		assert.strictEqual(new Set(keys(firstTry)).size, 3);
	});

	it('gives a new key to another execution, another run of the node, another node and another workflow', async () => {
		const keyFor = async (position: ExecutionPosition) => {
			const http = new MockHttp(receipts(1));
			await run([sendParams()], http, false, position);
			return keys(http)[0];
		};
		const base = await keyFor({ executionId: '1001', runIndex: 0 });
		const others = await Promise.all([
			keyFor({ executionId: '1002', runIndex: 0 }), // a manual retry is a new execution
			keyFor({ executionId: '1001', runIndex: 1 }), // a loop, or an AI Agent tool call
			keyFor({ executionId: '1001', runIndex: 0, nodeName: 'Sendly1' }),
			keyFor({ executionId: '1001', runIndex: 0, workflowId: 'wf-2' }),
			keyFor({ executionId: '1001', runIndex: 0, instanceId: 'instance-b' }),
		]);
		assert.strictEqual(new Set([base, ...others]).size, 6);
	});

	it('falls back to a random key when n8n gives no execution ID', async () => {
		const http = new MockHttp(receipts(2));
		await run([sendParams()], http, false, { executionId: null });
		await run([sendParams()], http, false, { executionId: null });
		const [first, second] = keys(http);
		assert.match(first, /^n8n-[0-9a-f-]{36}$/);
		assert.notStrictEqual(first, second);
	});

	it('uses the mapped Deduplication Key, namespaced, so a re-run of the same order is not sent twice', async () => {
		const http = new MockHttp([{ statusCode: 202, body: RECEIPT }]);
		await run([sendParams({ additionalFields: { idempotencyKey: ' order-1042 ' } })], http);
		assert.strictEqual(http.calls[0].headers['Idempotency-Key'], 'n8n-send:order-1042');
	});

	it('hashes a Deduplication Key that is not printable ASCII', async () => {
		const http = new MockHttp([{ statusCode: 202, body: RECEIPT }]);
		await run([sendParams({ additionalFields: { idempotencyKey: 'commande-é' } })], http);
		assert.match(String(http.calls[0].headers['Idempotency-Key']), /^n8n-send:[0-9a-f]{64}$/);
	});

	it('builds an inline send with every optional field', async () => {
		const http = new MockHttp([{ statusCode: 202, body: RECEIPT }]);
		await run(
			[
				sendParams({
					content: 'custom',
					subject: 'Your invoice',
					body: '<p>Hi {{ first_name }}</p>',
					additionalFields: {
						toName: 'Ada Lovelace',
						from: 'billing@acme.dev',
						fromName: 'Acme Billing',
						replyTo: 'support@acme.dev',
						cc: 'a@acme.dev, b@acme.dev',
						bcc: 'archive@acme.dev',
						tags: 'invoice, october',
						data: '{"first_name": "Ada"}',
					},
				}),
			],
			http,
		);
		assert.deepEqual(http.calls[0].body, {
			to: { email: 'ada@example.com', name: 'Ada Lovelace' },
			subject: 'Your invoice',
			body: '<p>Hi {{ first_name }}</p>',
			from: { email: 'billing@acme.dev', name: 'Acme Billing' },
			reply: 'support@acme.dev',
			data: { first_name: 'Ada' },
			cc: ['a@acme.dev', 'b@acme.dev'],
			bcc: ['archive@acme.dev'],
			tags: ['invoice', 'october'],
		});
	});

	it('retries once with the same key after a 5xx and returns the second answer', async () => {
		const http = new MockHttp([
			{ statusCode: 503, body: { code: 'unavailable', detail: 'Try again' } },
			{ statusCode: 202, body: RECEIPT },
		]);
		const [[item]] = await run([sendParams()], http);
		assert.deepEqual(item.json, RECEIPT);
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(
			http.calls[0].headers['Idempotency-Key'],
			http.calls[1].headers['Idempotency-Key'],
		);
	});

	it('retries once on 409 (the first request under this key is still in flight)', async () => {
		const http = new MockHttp([
			{ statusCode: 409, body: { code: 'conflict' } },
			{ statusCode: 202, body: RECEIPT },
		]);
		await run([sendParams()], http);
		assert.strictEqual(http.calls.length, 2);
	});

	it('surfaces an error, after exactly one retry, when both attempts answer 5xx or 409', async () => {
		for (const [first, second] of [
			[503, 503],
			[409, 409],
			[409, 502],
		]) {
			const http = new MockHttp([
				{ statusCode: first, body: { code: 'unavailable', detail: `First ${first}` } },
				{ statusCode: second, body: { code: 'unavailable', detail: `Second ${second}` } },
			]);
			const error = await rejection(run([sendParams()], http));
			assert.strictEqual(http.calls.length, 2);
			assert.strictEqual(error.constructor.name, 'NodeApiError');
			assert.match(error.message, new RegExp(`Sendly did not send the email: Second ${second}`));
			assert.strictEqual(error.httpCode, String(second));
		}
	});

	it('retries once with the same key when the request gets no answer (network error mid-send)', async () => {
		const http = new MockHttp([
			{ statusCode: 0, networkError: 'socket hang up' },
			{ statusCode: 202, body: RECEIPT },
		]);
		const [[item]] = await run([sendParams()], http);
		assert.deepEqual(item.json, RECEIPT);
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(keys(http)[0], keys(http)[1]);
	});

	it('reports the network error when the retry gets no answer either', async () => {
		const http = new MockHttp([
			{ statusCode: 0, networkError: 'socket hang up' },
			{ statusCode: 0, networkError: 'second attempt reset' },
		]);
		const error = await rejection(run([sendParams()], http));
		assert.strictEqual(http.calls.length, 2);
		assert.match(error.message, /second attempt reset/);
	});

	it("does not retry a validation error, and reports Sendly's own message and field errors", async () => {
		const http = new MockHttp([
			{
				statusCode: 422,
				body: {
					code: 'validation_error',
					detail: 'The request body is invalid.',
					request_id: 'req_123',
					errors: [{ pointer: '/to', message: 'Invalid email' }],
				},
			},
		]);
		const error = await rejection(run([sendParams({ to: 'not-an-email' })], http));
		assert.strictEqual(http.calls.length, 1);
		assert.strictEqual(error.constructor.name, 'NodeApiError');
		assert.match(error.message, /Sendly did not send the email: The request body is invalid\./);
		assert.match(String(error.description), /\/to: Invalid email/);
		assert.match(String(error.description), /req_123/);
		assert.strictEqual(error.httpCode, '422');
	});

	it('explains a spent sending allowance', async () => {
		const http = new MockHttp([
			{ statusCode: 402, body: { code: 'QUOTA_EXHAUSTED', detail: 'Monthly limit reached.' } },
		]);
		const error = await rejection(run([sendParams()], http));
		assert.match(String(error.description), /sending limit/);
	});

	it('explains a 403 as a missing permission or a publishable key', async () => {
		const http = new MockHttp([
			{
				statusCode: 403,
				body: { error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Forbidden' } },
			},
		]);
		const error = await rejection(run([sendParams()], http));
		assert.match(error.message, /Forbidden/);
		assert.match(String(error.description), /missing a permission/);
	});

	it('refuses to send without a template, before any request', async () => {
		const http = new MockHttp();
		const error = await rejection(run([sendParams({ template: locator('') })], http));
		assert.strictEqual(http.calls.length, 0);
		assert.strictEqual(error.constructor.name, 'NodeOperationError');
		assert.match(error.message, /No template was chosen/);
	});

	it('refuses invalid Template Variables JSON, before any request', async () => {
		const http = new MockHttp();
		const error = await rejection(
			run([sendParams({ additionalFields: { data: '{not json' } })], http),
		);
		assert.strictEqual(http.calls.length, 0);
		assert.match(error.message, /Template Variables/);
	});

	it('returns the error as an item and keeps going when Continue On Fail is on', async () => {
		const http = new MockHttp([
			{ statusCode: 422, body: { code: 'validation_error', detail: 'Bad sender' } },
			{ statusCode: 202, body: RECEIPT },
		]);
		const [items] = await run([sendParams(), sendParams()], http, true);
		assert.strictEqual(items.length, 2);
		assert.match(String(items[0].json.error), /Bad sender/);
		assert.deepEqual(items[0].pairedItem, { item: 0 });
		assert.deepEqual(items[1].json, RECEIPT);
	});
});
