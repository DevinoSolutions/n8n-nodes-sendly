import type { INodeProperties } from 'n8n-workflow';
import { emailField, UUID_PLACEHOLDER } from './common';

export const contactOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['contact'] } },
	options: [
		{
			name: 'Create or Update',
			value: 'upsert',
			action: 'Create or update a contact',
			description: 'Create a new record, or update the current one if it already exists (upsert)',
		},
		{
			name: 'Delete',
			value: 'delete',
			action: 'Delete a contact',
			description: 'Delete a contact. Emails already sent to it are kept.',
		},
		{
			name: 'Find by Email',
			value: 'findByEmail',
			action: 'Find a contact by email',
			description: 'Find the contact with an exact email address',
		},
		{
			name: 'Get',
			value: 'get',
			action: 'Get a contact',
			description: 'Retrieve a contact by ID',
		},
		{
			name: 'Get Many',
			value: 'getAll',
			action: 'Get many contacts',
			description: 'Retrieve a list of contacts, newest first',
		},
	],
	default: 'upsert',
};

const contactIdField: INodeProperties = {
	displayName: 'Contact ID',
	name: 'contactId',
	type: 'string',
	required: true,
	default: '',
	placeholder: UUID_PLACEHOLDER,
	description: 'The ID of the contact in Sendly',
	displayOptions: { show: { resource: ['contact'], operation: ['delete', 'get'] } },
};

export const contactFields: INodeProperties[] = [
	emailField(
		{ resource: ['contact'], operation: ['upsert'] },
		"The contact's email address. It identifies the contact and cannot be changed later.",
	),
	emailField(
		{ resource: ['contact'], operation: ['findByEmail'] },
		'The exact email address to look up. Letter case is ignored.',
	),
	contactIdField,

	/* ------------------------------ Create or Update ------------------------------ */
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['contact'], operation: ['upsert'] } },
		options: [
			{
				displayName: 'Custom Fields',
				name: 'customFields',
				type: 'json',
				default: '{}',
				description:
					'Fields to store on the contact as a JSON object, usable in templates as {{ field }}. Fields you leave out are kept, unless Replace Custom Fields is on.',
			},
			{
				displayName: 'Replace Custom Fields',
				name: 'replaceCustomFields',
				type: 'boolean',
				default: false,
				description:
					'Whether to remove every custom field of an existing contact that this node does not set. Off keeps them.',
			},
			{
				displayName: 'Subscribed',
				name: 'subscribed',
				type: 'boolean',
				default: true,
				description:
					"Whether the contact receives marketing email. Leave this field out to keep an existing contact's choice (a new contact is subscribed). Turning it on re-subscribes someone who unsubscribed: only do that with their consent.",
			},
		],
	},

	/* ---------------------------------- Get Many ---------------------------------- */
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: { resource: ['contact'], operation: ['getAll'] } },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
		displayOptions: { show: { resource: ['contact'], operation: ['getAll'], returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['contact'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Email Contains',
				name: 'search',
				type: 'string',
				default: '',
				placeholder: 'e.g. @example.com',
				description:
					'Only contacts whose email address contains this text (letter case is ignored)',
			},
			{
				displayName: 'Subscription',
				name: 'subscribed',
				type: 'options',
				default: 'true',
				options: [
					{ name: 'Subscribed', value: 'true' },
					{ name: 'Unsubscribed', value: 'false' },
				],
				description: 'Only subscribed or only unsubscribed contacts',
			},
		],
	},
];
