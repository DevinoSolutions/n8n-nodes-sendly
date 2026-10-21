import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type IHookFunctions,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type IN8nHttpFullResponse,
	type IWebhookFunctions,
	type JsonObject,
} from 'n8n-workflow';

/** Sendly's public REST API (https://docs.sendly.now). Every call is scoped to the key's project. */
export const API_BASE_URL = 'https://api.sendly.now';

/** Where a project member creates API keys. */
export const API_KEYS_SETTINGS =
	'Sendly under Settings > API keys (https://app.sendly.now/settings/api-keys)';

export type SendlyContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

export interface SendlyRequest {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	headers?: IDataObject;
}

export interface SendlyResponse<T = unknown> {
	statusCode: number;
	body: T;
	headers: IDataObject;
}

/**
 * One request with the Sendly credential, answering the status, headers and body of every
 * response, error statuses included. Callers that need to branch on a status (409 on create,
 * 404 on delete, a retryable 5xx) use this; everything else uses `sendlyApiRequest`.
 */
export async function sendlyRequest<T = unknown>(
	this: SendlyContext,
	request: SendlyRequest,
): Promise<SendlyResponse<T>> {
	const options: IHttpRequestOptions = {
		method: request.method,
		url: `${API_BASE_URL}${request.path}`,
		headers: { Accept: 'application/json', ...(request.headers ?? {}) },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (request.qs && Object.keys(request.qs).length > 0) {
		options.qs = request.qs;
	}
	if (request.body !== undefined) {
		options.body = request.body;
	}

	const response = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'sendlyApi',
		options,
	)) as IN8nHttpFullResponse;

	return {
		statusCode: response.statusCode,
		body: parseBody(response.body) as T,
		headers: (response.headers ?? {}) as IDataObject,
	};
}

/** Like `sendlyRequest`, but throws a readable `NodeApiError` for any error status. */
export async function sendlyApiRequest(
	this: SendlyContext,
	request: SendlyRequest,
	itemIndex?: number,
): Promise<IDataObject> {
	const response = (await sendlyRequest.call(this, request)) as SendlyResponse<IDataObject>;
	if (response.statusCode >= 400) {
		throwApiError.call(this, response, undefined, itemIndex);
	}
	return response.body;
}

function parseBody(body: unknown): unknown {
	if (typeof body === 'string' && body.trim() !== '') {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	return body;
}

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/**
 * One error, read from either of Sendly's two dialects: an RFC 9457 problem (`/api/v1/*`) or
 * the legacy envelope `{ error: { message, code } }` (`/api/*`).
 */
export interface ApiErrorDetails {
	/** Lower-cased, so `RATE_LIMIT_EXCEEDED` and `rate_limit_exceeded` read alike. */
	code?: string;
	message?: string;
	requestId?: string;
	fieldErrors: string[];
}

interface ProblemBody {
	code?: string;
	title?: string;
	detail?: string;
	request_id?: string;
	errors?: Array<{ pointer?: string; message?: string }>;
	error?: { code?: string; message?: string } | string;
}

export function readApiError(body: unknown): ApiErrorDetails {
	const problem = (typeof body === 'object' && body !== null ? body : {}) as ProblemBody;
	const legacy = typeof problem.error === 'object' && problem.error !== null ? problem.error : {};
	const code = problem.code ?? legacy.code;
	return {
		code: typeof code === 'string' ? code.toLowerCase() : undefined,
		message:
			problem.detail ??
			legacy.message ??
			(typeof problem.error === 'string' ? problem.error : undefined) ??
			problem.title ??
			(typeof body === 'string' && body.trim() !== '' ? body.slice(0, 300) : undefined),
		requestId: problem.request_id,
		fieldErrors: (problem.errors ?? [])
			.map((entry) => [entry.pointer, entry.message].filter(Boolean).join(': '))
			.filter((line) => line.length > 0),
	};
}

/** Codes the server answers for a missing permission, in both dialects. */
const SCOPE_CODES = new Set(['scope_missing', 'insufficient_permissions', 'forbidden']);
/** A spent monthly or daily sending allowance: retrying cannot help until it resets. */
const QUOTA_CODES = new Set(['quota_exhausted', 'billing_limit_exceeded']);

/**
 * Throws the error a failed response deserves: what went wrong in Sendly's own words, what to
 * do about it, and the request id support needs.
 */
export function throwApiError(
	this: SendlyContext,
	response: SendlyResponse<unknown>,
	context?: string,
	itemIndex?: number,
): never {
	const error = readApiError(response.body);
	const headline = error.message ?? `Sendly answered HTTP ${response.statusCode}`;
	const message = [context, headline].filter(Boolean).join(' ');
	const trace = error.requestId ? ` Request ID: ${error.requestId}.` : '';
	const fields = error.fieldErrors.length > 0 ? ` ${error.fieldErrors.join('; ')}.` : '';

	let hint = '';
	if (response.statusCode === 401) {
		hint = `Check the credential: it needs a valid secret API key (sk_...) from ${API_KEYS_SETTINGS}.`;
	} else if (response.statusCode === 403 && (!error.code || SCOPE_CODES.has(error.code))) {
		hint = `The API key is missing a permission this operation needs, or it is a publishable (pk_...) key, which can only send email. Edit the key's permissions in ${API_KEYS_SETTINGS}, or use a Full access secret key.`;
	} else if (error.code && QUOTA_CODES.has(error.code)) {
		hint =
			"The project has reached a sending limit. Check the project's usage and billing in Sendly.";
	} else if (response.statusCode === 429) {
		const retryAfter = response.headers['retry-after'];
		hint = `Sendly rate-limited this request (10 requests per second per key).${
			retryAfter ? ` Retry after ${String(retryAfter)} seconds.` : ''
		} Enable Retry On Fail on the node, or slow the workflow down.`;
	}

	const description = `${hint}${fields}${trace}`.trim();
	const errorBody: JsonObject =
		typeof response.body === 'object' && response.body !== null
			? (response.body as JsonObject)
			: { message: headline };

	throw new NodeApiError(this.getNode(), errorBody, {
		message,
		description: description || undefined,
		httpCode: String(response.statusCode),
		itemIndex,
	});
}
