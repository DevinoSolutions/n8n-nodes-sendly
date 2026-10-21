import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { Sendly } from '../nodes/Sendly/Sendly.node';
import { executeContext, locator, MockHttp, rejection } from './helpers';

const node = new Sendly();
const LIST_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CAMPAIGN_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';

async function run(params: IDataObject, http: MockHttp) {
	const [items] = await node.execute.call(executeContext([params], http));
	return items;
}

describe('List > Add Contact', () => {
	it('POSTs to /api/lists/{id}/subscribe and unwraps the legacy envelope', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					success: true,
					data: { membershipId: 'm1', status: 'CONFIRMED', created: true, previousStatus: null },
				},
			},
		]);
		const [item] = await run(
			{
				resource: 'list',
				operation: 'addContact',
				listId: locator(LIST_ID),
				email: 'ada@example.com',
				additionalFields: { customFields: '{"source":"n8n"}', allowResubscribe: true },
			},
			http,
		);
		assert.strictEqual(http.calls[0].method, 'POST');
		assert.strictEqual(http.calls[0].url, `https://api.sendly.now/api/lists/${LIST_ID}/subscribe`);
		assert.deepEqual(http.calls[0].body, {
			email: 'ada@example.com',
			data: { source: 'n8n' },
			allowResubscribe: true,
		});
		assert.deepEqual(item.json, {
			listId: LIST_ID,
			email: 'ada@example.com',
			membershipId: 'm1',
			status: 'CONFIRMED',
			created: true,
			previousStatus: null,
		});
	});

	it('never sends allowResubscribe unless it is turned on', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { success: true, data: { status: 'PENDING' } } },
		]);
		await run(
			{
				resource: 'list',
				operation: 'addContact',
				listId: locator(LIST_ID, 'id'),
				email: 'ada@example.com',
				additionalFields: {},
			},
			http,
		);
		assert.deepEqual(http.calls[0].body, { email: 'ada@example.com' });
	});

	it('surfaces the 409 a past opt-out answers', async () => {
		const http = new MockHttp([
			{
				statusCode: 409,
				body: {
					success: false,
					error: {
						code: 'RESUBSCRIBE_CONFIRMATION_REQUIRED',
						message: 'This address unsubscribed.',
					},
				},
			},
		]);
		const error = await rejection(
			run(
				{
					resource: 'list',
					operation: 'addContact',
					listId: locator(LIST_ID),
					email: 'ada@example.com',
					additionalFields: {},
				},
				http,
			),
		);
		assert.match(error.message, /This address unsubscribed\./);
		assert.strictEqual(error.httpCode, '409');
	});
});

describe('List > Remove Contact', () => {
	it('POSTs to /api/lists/{id}/unsubscribe', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { success: true, data: { email: 'ada@example.com' } } },
		]);
		const [item] = await run(
			{
				resource: 'list',
				operation: 'removeContact',
				listId: locator(LIST_ID),
				email: 'ada@example.com',
			},
			http,
		);
		assert.strictEqual(
			http.calls[0].url,
			`https://api.sendly.now/api/lists/${LIST_ID}/unsubscribe`,
		);
		assert.deepEqual(http.calls[0].body, { email: 'ada@example.com' });
		assert.deepEqual(item.json, { listId: LIST_ID, unsubscribed: true, email: 'ada@example.com' });
	});
});

describe('Campaign > Send', () => {
	const sent = { id: CAMPAIGN_ID, name: 'November', status: 'SENDING' };

	it('sends now with an Idempotency-Key derived from the campaign, the same on every run', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: sent },
			{ statusCode: 200, body: sent },
		]);
		const params = {
			resource: 'campaign',
			operation: 'send',
			campaignId: locator(CAMPAIGN_ID),
			additionalFields: {},
		};
		const [item] = await run(params, http);
		await run(params, http);
		assert.deepEqual(item.json, sent);
		assert.strictEqual(
			http.calls[0].url,
			`https://api.sendly.now/api/v1/campaigns/${CAMPAIGN_ID}/send`,
		);
		assert.deepEqual(http.calls[0].body, {});
		assert.match(String(http.calls[0].headers['Idempotency-Key']), /^n8n-[0-9a-f]{64}$/);
		assert.strictEqual(
			http.calls[0].headers['Idempotency-Key'],
			http.calls[1].headers['Idempotency-Key'],
		);
	});

	it('schedules with scheduled_for in UTC, under a different key than sending now', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { ...sent, status: 'SCHEDULED' } },
			{ statusCode: 200, body: sent },
		]);
		await run(
			{
				resource: 'campaign',
				operation: 'send',
				campaignId: locator(CAMPAIGN_ID),
				additionalFields: { scheduledFor: '2099-11-02T09:00:00+01:00' },
			},
			http,
		);
		await run(
			{
				resource: 'campaign',
				operation: 'send',
				campaignId: locator(CAMPAIGN_ID),
				additionalFields: {},
			},
			http,
		);
		assert.deepEqual(http.calls[0].body, { scheduled_for: '2099-11-02T08:00:00.000Z' });
		assert.notStrictEqual(
			http.calls[0].headers['Idempotency-Key'],
			http.calls[1].headers['Idempotency-Key'],
		);
	});

	it('refuses a Send At in the past, before any request', async () => {
		const http = new MockHttp();
		const error = await rejection(
			run(
				{
					resource: 'campaign',
					operation: 'send',
					campaignId: locator(CAMPAIGN_ID),
					additionalFields: { scheduledFor: '2020-01-01T00:00:00Z' },
				},
				http,
			),
		);
		assert.strictEqual(http.calls.length, 0);
		assert.match(error.message, /must be in the future/);
	});

	it('retries once on a 5xx with the same key', async () => {
		const http = new MockHttp([
			{ statusCode: 500, body: { code: 'internal_error' } },
			{ statusCode: 200, body: sent },
		]);
		await run(
			{
				resource: 'campaign',
				operation: 'send',
				campaignId: locator(CAMPAIGN_ID),
				additionalFields: {},
			},
			http,
		);
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(
			http.calls[0].headers['Idempotency-Key'],
			http.calls[1].headers['Idempotency-Key'],
		);
	});

	it('reports a campaign that already went out', async () => {
		const http = new MockHttp([
			{
				statusCode: 400,
				body: { code: 'invalid_state', detail: 'Campaign is not in DRAFT or SCHEDULED.' },
			},
		]);
		const error = await rejection(
			run(
				{
					resource: 'campaign',
					operation: 'send',
					campaignId: locator(CAMPAIGN_ID),
					additionalFields: {},
				},
				http,
			),
		);
		assert.match(error.message, /Sendly did not send the campaign: Campaign is not in DRAFT/);
	});
});
