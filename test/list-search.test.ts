import { assert, describe, it } from 'vitest';
import { searchCampaigns, searchLists, searchTemplates } from '../nodes/Sendly/listSearch';
import { Sendly } from '../nodes/Sendly/Sendly.node';
import { loadOptionsContext, MockHttp } from './helpers';

describe('Dropdowns (list search)', () => {
	it('registers the three list-search methods on the node', () => {
		assert.deepEqual(Object.keys(new Sendly().methods.listSearch).sort(), [
			'searchCampaigns',
			'searchLists',
			'searchTemplates',
		]);
	});

	it('lists subscriber lists, filtered by name, with the next cursor as pagination token', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					data: [
						{ id: 'l1', name: 'Newsletter' },
						{ id: 'l2', name: 'Beta testers' },
					],
					has_more: true,
					next_cursor: 'cur',
				},
			},
		]);
		const result = await searchLists.call(loadOptionsContext(http), 'news');
		assert.deepEqual(result, {
			results: [{ name: 'Newsletter', value: 'l1' }],
			paginationToken: 'cur',
		});
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/v1/lists');
		assert.deepEqual(http.calls[0].qs, { limit: 100 });
	});

	it('passes the search text and the pagination token to GET /api/v1/templates', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: { data: [{ id: 't1', name: 'Invoice' }], has_more: false, next_cursor: null },
			},
		]);
		const result = await searchTemplates.call(loadOptionsContext(http), 'inv', 'page-2');
		assert.deepEqual(result, {
			results: [{ name: 'Invoice', value: 't1' }],
			paginationToken: undefined,
		});
		assert.deepEqual(http.calls[0].qs, { limit: 100, search: 'inv', after: 'page-2' });
	});

	it('offers only draft and scheduled campaigns, the only ones that can be sent', async () => {
		const http = new MockHttp([
			{
				statusCode: 200,
				body: {
					data: [
						{ id: 'c1', name: 'November', status: 'DRAFT' },
						{ id: 'c2', name: 'October', status: 'SENT' },
						{ id: 'c3', name: 'Black Friday', status: 'SCHEDULED' },
					],
					has_more: false,
					next_cursor: null,
				},
			},
		]);
		const result = await searchCampaigns.call(loadOptionsContext(http));
		assert.deepEqual(result.results, [
			{ name: 'November', value: 'c1' },
			{ name: 'Black Friday (scheduled)', value: 'c3' },
		]);
	});
});
