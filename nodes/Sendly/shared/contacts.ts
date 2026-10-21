import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';
import { sendlyApiRequest, sendlyRequest, throwApiError } from './transport';

/**
 * Contacts on `/api/v1/contacts`. The address is the contact's identity: it is unique per
 * project, stored lower-cased, and not writable after creation, so "the contact for this email"
 * is a lookup by address and "create or update" is create-then-patch.
 */
export interface Contact extends IDataObject {
	id: string;
	email: string;
	subscribed: boolean;
	custom_fields: IDataObject[string];
	created_at: string;
	updated_at: string;
}

export interface CursorPage<T> {
	data: T[];
	has_more: boolean;
	next_cursor: string | null;
}

export function isPlainObject(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pages read before giving up on an exact match among substring hits. */
const MAX_SEARCH_PAGES = 3;

/**
 * The contact whose address is exactly `email`, or null. `search` is a case-insensitive
 * substring match, so a page can hold `ann@x.com` next to `joann@x.com`; the exact address is
 * picked out here.
 */
export async function findContactByEmail(
	this: IExecuteFunctions,
	email: string,
	itemIndex: number,
): Promise<Contact | null> {
	const wanted = email.trim().toLowerCase();
	let after: string | null = null;
	for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
		const qs: IDataObject = { search: wanted, limit: 100 };
		if (after) qs.after = after;
		const response = (await sendlyApiRequest.call(
			this,
			{ method: 'GET', path: '/api/v1/contacts', qs },
			itemIndex,
		)) as unknown as CursorPage<Contact>;
		const match = (response.data ?? []).find((contact) => contact.email.toLowerCase() === wanted);
		if (match) return match;
		if (!response.has_more || !response.next_cursor) return null;
		after = response.next_cursor;
	}
	return null;
}

export interface UpsertOptions {
	subscribed?: boolean;
	customFields?: IDataObject;
	replaceCustomFields?: boolean;
}

/**
 * POST /api/v1/contacts, and on 409 (the address exists) PATCH the existing contact. v1 has no
 * upsert by design, so the two steps are explicit here.
 *
 * `custom_fields` on PATCH REPLACES the stored object, so by default the existing fields are
 * read and merged with the new ones; Replace Custom Fields sends only the new ones. The
 * subscription is left alone unless the node sets it, so a workflow never re-subscribes someone
 * who unsubscribed by accident.
 */
export async function upsertContact(
	this: IExecuteFunctions,
	email: string,
	options: UpsertOptions,
	itemIndex: number,
): Promise<IDataObject> {
	const given = options.customFields ?? {};
	const hasFields = Object.keys(given).length > 0;

	const createBody: IDataObject = { email };
	if (options.subscribed !== undefined) createBody.subscribed = options.subscribed;
	if (hasFields) createBody.custom_fields = given;

	const created = await sendlyRequest.call(this, {
		method: 'POST',
		path: '/api/v1/contacts',
		body: createBody,
	});
	if (created.statusCode === 201 || created.statusCode === 200) {
		return { ...(created.body as IDataObject), created: true };
	}
	if (created.statusCode !== 409) {
		throwApiError.call(this, created, 'Sendly did not create the contact:', itemIndex);
	}

	const existing = await findContactByEmail.call(this, email, itemIndex);
	if (!existing) {
		throw new NodeOperationError(
			this.getNode(),
			`Sendly says a contact with ${email} exists, but it could not be found to update`,
			{ itemIndex, description: 'Try again in a moment.' },
		);
	}

	const replace = options.replaceCustomFields === true;
	const patch: IDataObject = {};
	if (options.subscribed !== undefined) patch.subscribed = options.subscribed;
	if (hasFields || replace) {
		patch.custom_fields =
			replace || !isPlainObject(existing.custom_fields)
				? given
				: { ...existing.custom_fields, ...given };
	}
	if (Object.keys(patch).length === 0) {
		return { ...existing, created: false };
	}

	const updated = await sendlyApiRequest.call(
		this,
		{
			method: 'PATCH',
			path: `/api/v1/contacts/${encodeURIComponent(existing.id)}`,
			body: patch,
		},
		itemIndex,
	);
	return { ...updated, created: false };
}
