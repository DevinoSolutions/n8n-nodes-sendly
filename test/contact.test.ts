import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { Sendly } from '../nodes/Sendly/Sendly.node';
import { executeContext, MockHttp, rejection } from './helpers';

const node = new Sendly();

function contact(overrides: IDataObject = {}): IDataObject {
	return {
		id: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
		email: 'ada@example.com',
		subscribed: true,
		custom_fields: { first_name: 'Ada', plan: 'free' },
		created_at: '2026-10-20T09:15:00.000Z',
		updated_at: '2026-10-20T09:15:00.000Z',
		...overrides,
	};
}

function page(data: IDataObject[], nextCursor: string | null = null): IDataObject {
	return { data, has_more: nextCursor !== null, next_cursor: nextCursor };
}

async function run(params: IDataObject, http: MockHttp) {
	const [items] = await node.execute.call(
		executeContext([{ resource: 'contact', ...params }], http),
	);
	return items;
}

describe('Contact > Create or Update', () => {
	it('creates a new contact with POST /api/v1/contacts', async () => {
		const http = new MockHttp([{ statusCode: 201, body: contact() }]);
		const [item] = await run(
			{
				operation: 'upsert',
				email: 'ada@example.com',
				additionalFields: { customFields: '{"first_name":"Ada","plan":"free"}', subscribed: true },
			},
			http,
		);
		assert.strictEqual(item.json.created, true);
		assert.strictEqual(http.calls.length, 1);
		assert.strictEqual(http.calls[0].method, 'POST');
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/v1/contacts');
		assert.deepEqual(http.calls[0].body, {
			email: 'ada@example.com',
			subscribed: true,
			custom_fields: { first_name: 'Ada', plan: 'free' },
		});
	});

	it('leaves the subscription out of the request unless the node sets it', async () => {
		const http = new MockHttp([{ statusCode: 201, body: contact() }]);
		await run({ operation: 'upsert', email: 'ada@example.com', additionalFields: {} }, http);
		assert.deepEqual(http.calls[0].body, { email: 'ada@example.com' });
	});

	it('on 409 finds the exact address and PATCHes it, merging custom fields', async () => {
		const existing = contact();
		const http = new MockHttp([
			{ statusCode: 409, body: { code: 'conflict', detail: 'Contact exists' } },
			{
				statusCode: 200,
				body: page([contact({ id: 'other', email: 'joann.ada@example.com' }), existing]),
			},
			{ statusCode: 200, body: contact({ custom_fields: { first_name: 'Ada', plan: 'pro' } }) },
		]);
		const [item] = await run(
			{
				operation: 'upsert',
				email: 'Ada@Example.com',
				additionalFields: { customFields: { plan: 'pro' } },
			},
			http,
		);
		assert.strictEqual(item.json.created, false);
		assert.deepEqual(http.calls[1].qs, { search: 'ada@example.com', limit: 100 });
		assert.strictEqual(http.calls[2].method, 'PATCH');
		assert.strictEqual(
			http.calls[2].url,
			`https://api.sendly.now/api/v1/contacts/${String(existing.id)}`,
		);
		assert.deepEqual(http.calls[2].body, { custom_fields: { first_name: 'Ada', plan: 'pro' } });
	});

	it('replaces custom fields instead of merging when Replace Custom Fields is on', async () => {
		const http = new MockHttp([
			{ statusCode: 409, body: { code: 'conflict' } },
			{ statusCode: 200, body: page([contact()]) },
			{ statusCode: 200, body: contact({ custom_fields: { plan: 'pro' } }) },
		]);
		await run(
			{
				operation: 'upsert',
				email: 'ada@example.com',
				additionalFields: { customFields: '{"plan":"pro"}', replaceCustomFields: true },
			},
			http,
		);
		assert.deepEqual(http.calls[2].body, { custom_fields: { plan: 'pro' } });
	});

	it('does not PATCH an existing contact when there is nothing to change', async () => {
		const http = new MockHttp([
			{ statusCode: 409, body: { code: 'conflict' } },
			{ statusCode: 200, body: page([contact()]) },
		]);
		const [item] = await run(
			{ operation: 'upsert', email: 'ada@example.com', additionalFields: {} },
			http,
		);
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(item.json.created, false);
		assert.strictEqual(item.json.email, 'ada@example.com');
	});

	it("reports any other create error with Sendly's message", async () => {
		const http = new MockHttp([
			{ statusCode: 422, body: { code: 'validation_error', detail: 'Bad email' } },
		]);
		const error = await rejection(
			run({ operation: 'upsert', email: 'nope', additionalFields: {} }, http),
		);
		assert.match(error.message, /Sendly did not create the contact: Bad email/);
	});
});

describe('Contact > Find by Email', () => {
	it('returns only the exact address among substring matches, across pages', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: page([contact({ email: 'joann@example.com' })], 'cursor-2') },
			{ statusCode: 200, body: page([contact({ email: 'ann@example.com', id: 'ann' })]) },
		]);
		const items = await run({ operation: 'findByEmail', email: 'ANN@example.com' }, http);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].json.id, 'ann');
		assert.deepEqual(http.calls[1].qs, {
			search: 'ann@example.com',
			limit: 100,
			after: 'cursor-2',
		});
	});

	it('returns no items when nobody has that address', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: page([contact({ email: 'joann@example.com' })]) },
		]);
		const items = await run({ operation: 'findByEmail', email: 'ann@example.com' }, http);
		assert.strictEqual(items.length, 0);
	});
});

describe('Contact > Get, Delete and Get Many', () => {
	it('gets a contact by ID', async () => {
		const http = new MockHttp([{ statusCode: 200, body: contact() }]);
		const [item] = await run({ operation: 'get', contactId: 'c-1' }, http);
		assert.strictEqual(item.json.email, 'ada@example.com');
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/v1/contacts/c-1');
	});

	it('reports a missing contact as a 404 NodeApiError', async () => {
		const http = new MockHttp([
			{ statusCode: 404, body: { code: 'not_found', detail: 'Contact not found' } },
		]);
		const error = await rejection(run({ operation: 'get', contactId: 'missing' }, http));
		assert.strictEqual(error.constructor.name, 'NodeApiError');
		assert.strictEqual(error.httpCode, '404');
	});

	it('deletes a contact by ID', async () => {
		const http = new MockHttp([{ statusCode: 200, body: { id: 'c-1', deleted: true } }]);
		const [item] = await run({ operation: 'delete', contactId: 'c-1' }, http);
		assert.deepEqual(item.json, { id: 'c-1', deleted: true });
		assert.strictEqual(http.calls[0].method, 'DELETE');
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/v1/contacts/c-1');
	});

	it('gets up to Limit contacts with the filters as query parameters', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: page([contact(), contact({ id: 'b' })], 'next') },
		]);
		const items = await run(
			{
				operation: 'getAll',
				returnAll: false,
				limit: 2,
				filters: { search: '@example.com', subscribed: 'false' },
			},
			http,
		);
		assert.strictEqual(items.length, 2);
		assert.strictEqual(http.calls.length, 1);
		assert.deepEqual(http.calls[0].qs, { search: '@example.com', subscribed: 'false', limit: 2 });
	});

	it('follows next_cursor until the last page with Return All', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: page([contact({ id: 'a' })], 'c2') },
			{ statusCode: 200, body: page([contact({ id: 'b' })], 'c3') },
			{ statusCode: 200, body: page([contact({ id: 'c' })]) },
		]);
		const items = await run({ operation: 'getAll', returnAll: true, filters: {} }, http);
		assert.deepEqual(
			items.map((item) => item.json.id),
			['a', 'b', 'c'],
		);
		assert.deepEqual(http.calls[0].qs, { limit: 100 });
		assert.deepEqual(http.calls[2].qs, { limit: 100, after: 'c3' });
	});
});
