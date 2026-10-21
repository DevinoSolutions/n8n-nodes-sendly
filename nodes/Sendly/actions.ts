import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';
import {
	findContactByEmail,
	upsertContact,
	type Contact,
	type CursorPage,
} from './shared/contacts';
import { derivedIdempotencyKey, sendIdempotencyKey, sendWithOneRetry } from './shared/idempotency';
import { sendlyApiRequest, sendlyRequest, throwApiError } from './shared/transport';
import { parseJsonObject, toIsoOrNull, toStringList } from './shared/utils';

type Handler = (this: IExecuteFunctions, itemIndex: number) => Promise<IDataObject | IDataObject[]>;

function locatorValue(this: IExecuteFunctions, name: string, itemIndex: number): string {
	return String(this.getNodeParameter(name, itemIndex, '', { extractValue: true }) ?? '').trim();
}

function requiredString(
	this: IExecuteFunctions,
	name: string,
	displayName: string,
	itemIndex: number,
): string {
	const value = String(this.getNodeParameter(name, itemIndex, '') ?? '').trim();
	if (value === '') {
		throw new NodeOperationError(this.getNode(), `The '${displayName}' parameter is empty`, {
			itemIndex,
		});
	}
	return value;
}

/* -------------------------------------------------------------------------- */
/*                                    Email                                   */
/* -------------------------------------------------------------------------- */

/** The SendEmailV1 body. Empty fields are left out. */
export function buildSendBody(this: IExecuteFunctions, itemIndex: number): IDataObject {
	const to = requiredString.call(this, 'to', 'To', itemIndex);
	const content = this.getNodeParameter('content', itemIndex, 'template') as string;
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const text = (key: string) => (typeof fields[key] === 'string' ? fields[key].trim() : '');

	const toName = text('toName');
	const body: IDataObject = { to: toName ? { email: to, name: toName } : to };

	if (content === 'custom') {
		body.subject = requiredString.call(this, 'subject', 'Subject', itemIndex);
		body.body = requiredString.call(this, 'body', 'Body (HTML)', itemIndex);
	} else {
		const template = locatorValue.call(this, 'template', itemIndex);
		if (!template) {
			throw new NodeOperationError(this.getNode(), 'No template was chosen', {
				itemIndex,
				description: "Pick a template, or switch 'Content' to 'Subject and Body'.",
			});
		}
		body.template = template;
	}

	const from = text('from');
	const fromName = text('fromName');
	if (from) body.from = fromName ? { email: from, name: fromName } : from;
	if (text('replyTo')) body.reply = text('replyTo');

	const data = parseJsonObject.call(this, fields.data, 'Template Variables', itemIndex);
	if (data && Object.keys(data).length > 0) body.data = data;

	for (const key of ['cc', 'bcc', 'tags'] as const) {
		const list = toStringList(fields[key]);
		if (list.length > 0) body[key] = list;
	}
	return body;
}

/**
 * POST /api/v1/emails with an `Idempotency-Key`, retried once with the same key on a 5xx or a
 * 409. The receipt's `status` is usually PENDING: the email is queued, and its delivery, opens
 * and clicks arrive later through the Sendly Trigger.
 */
const sendEmail: Handler = async function (itemIndex) {
	const body = buildSendBody.call(this, itemIndex);
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const key = sendIdempotencyKey(fields.idempotencyKey);
	const response = await sendWithOneRetry(
		async () =>
			await sendlyRequest.call(this, {
				method: 'POST',
				path: '/api/v1/emails',
				headers: { 'Idempotency-Key': key },
				body,
			}),
	);
	if (response.statusCode >= 400) {
		throwApiError.call(this, response, 'Sendly did not send the email:', itemIndex);
	}
	return response.body as IDataObject;
};

/* -------------------------------------------------------------------------- */
/*                                   Contact                                  */
/* -------------------------------------------------------------------------- */

const upsert: Handler = async function (itemIndex) {
	const email = requiredString.call(this, 'email', 'Email', itemIndex);
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	return await upsertContact.call(
		this,
		email,
		{
			subscribed: typeof fields.subscribed === 'boolean' ? fields.subscribed : undefined,
			customFields: parseJsonObject.call(this, fields.customFields, 'Custom Fields', itemIndex),
			replaceCustomFields: fields.replaceCustomFields === true,
		},
		itemIndex,
	);
};

const findByEmail: Handler = async function (itemIndex) {
	const email = requiredString.call(this, 'email', 'Email', itemIndex);
	const contact = await findContactByEmail.call(this, email, itemIndex);
	// No match is "nothing found", not an error: the item is dropped so the workflow can branch
	// with "Always Output Data".
	return contact ? [contact] : [];
};

const getContact: Handler = async function (itemIndex) {
	const id = requiredString.call(this, 'contactId', 'Contact ID', itemIndex);
	return await sendlyApiRequest.call(
		this,
		{ method: 'GET', path: `/api/v1/contacts/${encodeURIComponent(id)}` },
		itemIndex,
	);
};

const deleteContact: Handler = async function (itemIndex) {
	const id = requiredString.call(this, 'contactId', 'Contact ID', itemIndex);
	return await sendlyApiRequest.call(
		this,
		{ method: 'DELETE', path: `/api/v1/contacts/${encodeURIComponent(id)}` },
		itemIndex,
	);
};

/** Upper bound on pages for Return All, so a huge project cannot run one item forever. */
const MAX_PAGES = 200;

const getManyContacts: Handler = async function (itemIndex) {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;

	const baseQs: IDataObject = {};
	if (typeof filters.search === 'string' && filters.search.trim() !== '') {
		baseQs.search = filters.search.trim();
	}
	if (filters.subscribed === 'true' || filters.subscribed === 'false') {
		baseQs.subscribed = filters.subscribed;
	}

	const results: Contact[] = [];
	let after: string | null = null;
	for (let page = 0; page < MAX_PAGES && results.length < limit; page++) {
		const qs: IDataObject = { ...baseQs, limit: Math.min(100, limit - results.length) };
		if (after) qs.after = after;
		const response = (await sendlyApiRequest.call(
			this,
			{ method: 'GET', path: '/api/v1/contacts', qs },
			itemIndex,
		)) as unknown as CursorPage<Contact>;
		results.push(...(response.data ?? []));
		if (!response.has_more || !response.next_cursor) break;
		after = response.next_cursor;
	}
	return results.slice(0, limit);
};

/* -------------------------------------------------------------------------- */
/*                                    List                                    */
/* -------------------------------------------------------------------------- */

function listId(this: IExecuteFunctions, itemIndex: number): string {
	const id = locatorValue.call(this, 'listId', itemIndex);
	if (!id) {
		throw new NodeOperationError(this.getNode(), 'No list was chosen', { itemIndex });
	}
	return id;
}

/** POST /api/lists/{id}/subscribe answers the legacy `{ success, data }` envelope. */
function unwrap(response: IDataObject): IDataObject {
	return (response.data as IDataObject | undefined) ?? response;
}

const addToList: Handler = async function (itemIndex) {
	const id = listId.call(this, itemIndex);
	const email = requiredString.call(this, 'email', 'Email', itemIndex);
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const body: IDataObject = { email };
	const data = parseJsonObject.call(this, fields.customFields, 'Custom Fields', itemIndex);
	if (data && Object.keys(data).length > 0) body.data = data;
	if (fields.allowResubscribe === true) body.allowResubscribe = true;

	const response = await sendlyApiRequest.call(
		this,
		{ method: 'POST', path: `/api/lists/${encodeURIComponent(id)}/subscribe`, body },
		itemIndex,
	);
	return { listId: id, email, ...unwrap(response) };
};

const removeFromList: Handler = async function (itemIndex) {
	const id = listId.call(this, itemIndex);
	const email = requiredString.call(this, 'email', 'Email', itemIndex);
	const response = await sendlyApiRequest.call(
		this,
		{ method: 'POST', path: `/api/lists/${encodeURIComponent(id)}/unsubscribe`, body: { email } },
		itemIndex,
	);
	return { listId: id, unsubscribed: true, ...unwrap(response) };
};

/* -------------------------------------------------------------------------- */
/*                                  Campaign                                  */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/v1/campaigns/{id}/send. Safe to repeat: the server sends a campaign once (it answers
 * 400 once the campaign is no longer DRAFT or SCHEDULED), and the `Idempotency-Key` is derived
 * from the campaign and the time, so a retried or re-run node replays the first answer instead of
 * racing it.
 */
const sendCampaign: Handler = async function (itemIndex) {
	const campaignId = locatorValue.call(this, 'campaignId', itemIndex);
	if (!campaignId) {
		throw new NodeOperationError(this.getNode(), 'No campaign was chosen', { itemIndex });
	}
	const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;

	let scheduledFor: string | undefined;
	if (fields.scheduledFor !== undefined && fields.scheduledFor !== '') {
		const iso = toIsoOrNull(fields.scheduledFor);
		if (iso === null) {
			throw new NodeOperationError(this.getNode(), "'Send At' is not a date and time", {
				itemIndex,
				description: 'Use a date and time such as 2026-11-02T09:00:00+01:00.',
			});
		}
		if (new Date(iso).getTime() <= Date.now()) {
			throw new NodeOperationError(
				this.getNode(),
				`'Send At' must be in the future; ${iso} has passed`,
				{
					itemIndex,
					description: "Remove 'Send At' to send now.",
				},
			);
		}
		scheduledFor = iso;
	}

	const key = derivedIdempotencyKey('campaign-send', campaignId, scheduledFor ?? 'now');
	const response = await sendWithOneRetry(
		async () =>
			await sendlyRequest.call(this, {
				method: 'POST',
				path: `/api/v1/campaigns/${encodeURIComponent(campaignId)}/send`,
				headers: { 'Idempotency-Key': key },
				body: scheduledFor ? { scheduled_for: scheduledFor } : {},
			}),
	);
	if (response.statusCode >= 400) {
		throwApiError.call(this, response, 'Sendly did not send the campaign:', itemIndex);
	}
	return response.body as IDataObject;
};

export const handlers: Record<string, Record<string, Handler>> = {
	email: { send: sendEmail },
	contact: {
		upsert,
		findByEmail,
		get: getContact,
		getAll: getManyContacts,
		delete: deleteContact,
	},
	list: { addContact: addToList, removeContact: removeFromList },
	campaign: { send: sendCampaign },
};
