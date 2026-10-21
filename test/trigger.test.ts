import { createHmac } from 'node:crypto';
import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { SendlyTrigger } from '../nodes/SendlyTrigger/SendlyTrigger.node';
import {
	hookContext,
	MockHttp,
	rejection,
	WEBHOOK_URL,
	webhookContext,
	type WebhookResponseRecorder,
} from './helpers';

const trigger = new SendlyTrigger();
const hooks = trigger.webhookMethods.default;
const SECRET = `whsec_${Buffer.from('a-32-byte-signing-key-for-tests!').toString('base64')}`;
const WEBHOOK_ID = '9a8b7c6d-5e4f-4321-8765-0fedcba98765';

/** Signs like Sendly's WebhookSigning.ts, independently of the node's own code. */
function sign(secret: string, id: string, timestamp: string, body: string): string {
	const key = secret.startsWith('whsec_')
		? Buffer.from(secret.slice('whsec_'.length), 'base64')
		: Buffer.from(secret, 'utf8');
	return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function delivery(event: string, data: IDataObject, timestamp = '1792500000000') {
	return JSON.stringify({ event, data, timestamp });
}

function signedHeaders(body: string, secret = SECRET, id = 'msg_1'): IDataObject {
	const timestamp = '1792500000';
	return {
		'content-type': 'application/json',
		'webhook-id': id,
		'webhook-timestamp': timestamp,
		'webhook-signature': sign(secret, id, timestamp, body),
	};
}

async function receive(options: {
	body: string;
	headers: IDataObject;
	events: string[];
	staticData?: IDataObject;
	http?: MockHttp;
	includeDetails?: boolean;
}) {
	const recorder: WebhookResponseRecorder = {};
	const http = options.http ?? new MockHttp();
	const result = await trigger.webhook.call(
		webhookContext({
			parameters: {
				events: options.events,
				options:
					options.includeDetails === undefined ? {} : { includeDetails: options.includeDetails },
			},
			staticData: options.staticData ?? { webhookId: WEBHOOK_ID, webhookSecret: SECRET },
			headers: options.headers,
			rawBody: options.body,
			http,
			recorder,
		}),
	);
	return { result, recorder, http };
}

describe('Sendly Trigger > webhook lifecycle', () => {
	it('is a trigger with no inputs, one POST webhook and every Sendly event type', () => {
		const { description } = trigger;
		assert.deepEqual(description.inputs, []);
		assert.strictEqual(description.webhooks?.[0].httpMethod, 'POST');
		const events = description.properties[0].options as Array<{ value: string }>;
		assert.deepEqual(events.map((event) => event.value).sort(), [
			'contact.created',
			'contact.unsubscribed',
			'email.bounced',
			'email.clicked',
			'email.complained',
			'email.delivered',
			'email.failed',
			'email.opened',
			'email.sent',
		]);
	});

	it('create registers the n8n URL for the chosen events and keeps the show-once secret', async () => {
		const staticData: IDataObject = {};
		const http = new MockHttp([
			{
				statusCode: 201,
				body: {
					webhook: {
						id: WEBHOOK_ID,
						url: WEBHOOK_URL,
						event_types: ['email.opened'],
						status: 'ACTIVE',
					},
					secret: SECRET,
				},
			},
		]);
		const created = await hooks.create.call(
			hookContext({ events: ['email.opened', 'email.clicked'] }, staticData, http),
		);
		assert.strictEqual(created, true);
		assert.strictEqual(http.calls[0].method, 'POST');
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/v1/webhooks');
		assert.deepEqual(http.calls[0].body, {
			url: WEBHOOK_URL,
			event_types: ['email.opened', 'email.clicked'],
		});
		assert.deepEqual(staticData, { webhookId: WEBHOOK_ID, webhookSecret: SECRET });
	});

	it('create reports a refused registration (for example a key without webhooks:write)', async () => {
		const http = new MockHttp([
			{ statusCode: 403, body: { code: 'scope_missing', detail: 'Missing webhooks:write' } },
		]);
		const error = await rejection(
			hooks.create.call(hookContext({ events: ['email.opened'] }, {}, http)),
		);
		assert.match(error.message, /refused to register the webhook/);
		assert.match(String(error.description), /missing a permission/);
	});

	it('checkExists is false, without a request, when nothing was registered', async () => {
		const http = new MockHttp();
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['email.opened'] }, {}, http)),
			false,
		);
		assert.strictEqual(http.calls.length, 0);
	});

	it('checkExists is true for an active webhook with this URL and these events', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					id: WEBHOOK_ID,
					url: WEBHOOK_URL,
					event_types: ['email.clicked', 'email.opened'],
					status: 'ACTIVE',
				},
			},
		]);
		const staticData = { webhookId: WEBHOOK_ID, webhookSecret: SECRET };
		const exists = await hooks.checkExists.call(
			hookContext({ events: ['email.opened', 'email.clicked'] }, staticData, http),
		);
		assert.strictEqual(exists, true);
		assert.strictEqual(http.calls[0].url, `https://api.sendly.now/api/v1/webhooks/${WEBHOOK_ID}`);
	});

	it('checkExists forgets a webhook deleted in Sendly (404)', async () => {
		const http = new MockHttp([{ statusCode: 404, body: { code: 'not_found' } }]);
		const staticData: IDataObject = { webhookId: WEBHOOK_ID, webhookSecret: SECRET };
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['email.opened'] }, staticData, http)),
			false,
		);
		assert.deepEqual(staticData, {});
	});

	it('checkExists replaces a webhook whose events changed or that Sendly disabled', async () => {
		for (const record of [
			{ event_types: ['email.opened'], status: 'ACTIVE' },
			{ event_types: ['email.clicked'], status: 'DISABLED' },
		]) {
			const http = new MockHttp([
				{ statusCode: 200, body: { id: WEBHOOK_ID, url: WEBHOOK_URL, ...record } },
				{ statusCode: 200, body: { id: WEBHOOK_ID, deleted: true } },
			]);
			const staticData: IDataObject = { webhookId: WEBHOOK_ID, webhookSecret: SECRET };
			const exists = await hooks.checkExists.call(
				hookContext({ events: ['email.clicked'] }, staticData, http),
			);
			assert.strictEqual(exists, false);
			assert.strictEqual(http.calls[1].method, 'DELETE');
			assert.deepEqual(staticData, {});
		}
	});

	it('delete removes the webhook and forgets it; a 404 counts as removed', async () => {
		for (const statusCode of [200, 404]) {
			const http = new MockHttp([{ statusCode, body: {} }]);
			const staticData: IDataObject = { webhookId: WEBHOOK_ID, webhookSecret: SECRET };
			assert.strictEqual(
				await hooks.delete.call(hookContext({ events: [] }, staticData, http)),
				true,
			);
			assert.strictEqual(http.calls[0].method, 'DELETE');
			assert.strictEqual(http.calls[0].url, `https://api.sendly.now/api/v1/webhooks/${WEBHOOK_ID}`);
			assert.deepEqual(staticData, {});
		}
	});

	it('delete reports failure and keeps the record when Sendly errors', async () => {
		const http = new MockHttp([{ statusCode: 500, body: {} }]);
		const staticData: IDataObject = { webhookId: WEBHOOK_ID, webhookSecret: SECRET };
		assert.strictEqual(
			await hooks.delete.call(hookContext({ events: [] }, staticData, http)),
			false,
		);
		assert.strictEqual(staticData.webhookId, WEBHOOK_ID);
	});
});

describe('Sendly Trigger > deliveries', () => {
	it('verifies the signature and emits the event with the email read back from Sendly', async () => {
		const body = delivery('email.opened', { emailId: 'e-1', ts: 1792500001000 });
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					success: true,
					data: { id: 'e-1', to: 'ada@example.com', subject: 'Invoice', opens: 1 },
				},
			},
		]);
		const { result, recorder } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['email.opened'],
			http,
		});
		assert.strictEqual(recorder.statusCode, undefined);
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/emails/e-1');
		const [[item]] = result.workflowData ?? [];
		assert.deepEqual(item.json, {
			event: 'email.opened',
			event_id: 'msg_1',
			occurred_at: new Date(1792500001000).toISOString(),
			test: false,
			data: { emailId: 'e-1', ts: 1792500001000 },
			email: { id: 'e-1', to: 'ada@example.com', subject: 'Invoice', opens: 1 },
		});
	});

	it('reads the contact back for contact events', async () => {
		const body = delivery('contact.created', {
			contactId: 'c-1',
			email: 'ada@example.com',
			subscribed: true,
			timestamp: '2026-10-20T09:15:00.000Z',
		});
		const http = new MockHttp([
			{
				statusCode: 200,
				body: { id: 'c-1', email: 'ada@example.com', custom_fields: { plan: 'pro' } },
			},
		]);
		const { result } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['contact.created'],
			http,
		});
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/v1/contacts/c-1');
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.occurred_at, '2026-10-20T09:15:00.000Z');
		assert.deepEqual(item.json.contact, {
			id: 'c-1',
			email: 'ada@example.com',
			custom_fields: { plan: 'pro' },
		});
	});

	it('still emits the event when the read-back fails, with the detail left empty', async () => {
		const body = delivery('email.bounced', { emailId: 'gone', bounceType: 'Permanent' });
		const http = new MockHttp([{ statusCode: 404, body: { error: { message: 'Not found' } } }]);
		const { result } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['email.bounced'],
			http,
		});
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.email, null);
	});

	it('skips the read-back when Include Details is off, and for dashboard test deliveries', async () => {
		const plain = delivery('email.clicked', { emailId: 'e-1', link: 'https://acme.dev' });
		const off = await receive({
			body: plain,
			headers: signedHeaders(plain),
			events: ['email.clicked'],
			includeDetails: false,
		});
		assert.strictEqual(off.http.calls.length, 0);
		assert.strictEqual((off.result.workflowData ?? [])[0][0].json.email, undefined);

		const test = delivery('email.clicked', { emailId: 'made-up', test: true });
		const testRun = await receive({
			body: test,
			headers: signedHeaders(test),
			events: ['email.clicked'],
		});
		assert.strictEqual(testRun.http.calls.length, 0);
		assert.strictEqual((testRun.result.workflowData ?? [])[0][0].json.test, true);
	});

	it('refuses a forged delivery with 401 and does not start the workflow', async () => {
		const body = delivery('email.opened', { emailId: 'e-1' });
		const forged = signedHeaders(body, `whsec_${Buffer.from('another-key').toString('base64')}`);
		const { result, recorder, http } = await receive({
			body,
			headers: forged,
			events: ['email.opened'],
		});
		assert.deepEqual(result, { noWebhookResponse: true });
		assert.strictEqual(recorder.statusCode, 401);
		assert.strictEqual(http.calls.length, 0);
	});

	it('refuses a body changed after signing', async () => {
		const body = delivery('email.opened', { emailId: 'e-1' });
		const headers = signedHeaders(body);
		const { recorder } = await receive({
			body: delivery('email.opened', { emailId: 'e-2' }),
			headers,
			events: ['email.opened'],
		});
		assert.strictEqual(recorder.statusCode, 401);
	});

	it('refuses a delivery when the workflow has no signing secret on record', async () => {
		const body = delivery('email.opened', { emailId: 'e-1' });
		const { recorder } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['email.opened'],
			staticData: {},
		});
		assert.strictEqual(recorder.statusCode, 401);
	});

	it('refuses a delivery without the Standard Webhooks headers', async () => {
		const body = delivery('email.opened', { emailId: 'e-1' });
		const { recorder } = await receive({
			body,
			headers: { 'content-type': 'application/json' },
			events: ['email.opened'],
		});
		assert.strictEqual(recorder.statusCode, 401);
	});

	it('accepts any matching signature during a secret rotation, and older non-whsec secrets', async () => {
		const legacySecret = 'legacy-plain-secret';
		const body = delivery('email.sent', { emailId: 'e-1' });
		const headers = signedHeaders(body, legacySecret);
		headers['webhook-signature'] =
			`${sign(SECRET.replace(/.$/, 'A'), 'msg_1', '1792500000', body)} ${String(headers['webhook-signature'])}`;
		const { result, recorder } = await receive({
			body,
			headers,
			events: ['email.sent'],
			staticData: { webhookId: WEBHOOK_ID, webhookSecret: legacySecret },
			includeDetails: false,
		});
		assert.strictEqual(recorder.statusCode, undefined);
		assert.strictEqual((result.workflowData ?? [])[0][0].json.event, 'email.sent');
	});

	it('ignores a signed event the node is not listening for', async () => {
		const body = delivery('contact.unsubscribed', { contactId: 'c-1' });
		const { result } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['email.opened'],
		});
		assert.deepEqual(result, {});
	});
});
