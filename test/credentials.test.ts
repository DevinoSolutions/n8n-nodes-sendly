import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { SendlyApi } from '../credentials/SendlyApi.credentials';
import { MockHttp } from './helpers';

const credential = new SendlyApi();

/** Resolves the credential's `={{$credentials.x}}` header expressions the way n8n does. */
function authHeaders(apiKey: string): IDataObject {
	const headers = (credential.authenticate.properties.headers ?? {}) as IDataObject;
	return Object.fromEntries(
		Object.entries(headers).map(([name, template]) => [
			name,
			String(template).replace(/^=/, '').replace('{{$credentials.apiKey}}', apiKey),
		]),
	);
}

/** n8n's credential test: the `test` request, with the credential's auth applied. */
async function runCredentialTest(http: MockHttp, apiKey: string): Promise<boolean> {
	const request = credential.test.request;
	const response = await http.handle('sendlyApi', {
		method: request.method,
		url: `${String(request.baseURL)}${String(request.url)}`,
		headers: authHeaders(apiKey),
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	});
	return response.statusCode < 400;
}

describe('Sendly API credential', () => {
	it('is named sendlyApi and stores one secret, password-masked API key', () => {
		assert.strictEqual(credential.name, 'sendlyApi');
		assert.strictEqual(credential.properties.length, 1);
		const [apiKey] = credential.properties;
		assert.strictEqual(apiKey.name, 'apiKey');
		assert.strictEqual(apiKey.required, true);
		assert.deepEqual(apiKey.typeOptions, { password: true });
	});

	it('sends the key as a Bearer token, the header the Sendly API and the Zapier app use', () => {
		assert.deepEqual(authHeaders('sk_example'), { Authorization: 'Bearer sk_example' });
	});

	it('tests the connection with GET https://api.sendly.now/api/v1/projects', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { id: 'p1', name: 'Acme', disabled: false } },
		]);
		assert.strictEqual(await runCredentialTest(http, 'sk_example'), true);
		assert.strictEqual(http.calls.length, 1);
		assert.strictEqual(http.calls[0].method, 'GET');
		assert.strictEqual(http.calls[0].url, 'https://api.sendly.now/api/v1/projects');
		assert.strictEqual(http.calls[0].headers.Authorization, 'Bearer sk_example');
	});

	it('fails the connection test for a revoked key (401)', async () => {
		const http = new MockHttp([{ statusCode: 401, body: { code: 'unauthorized' } }]);
		assert.strictEqual(await runCredentialTest(http, 'sk_revoked'), false);
	});

	it('fails the connection test for a publishable pk_ key, which Sendly answers with 403', async () => {
		const http = new MockHttp([{ statusCode: 403, body: { code: 'insufficient_permissions' } }]);
		assert.strictEqual(await runCredentialTest(http, 'pk_sending_only'), false);
	});
});
