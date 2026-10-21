import type { INodeProperties } from 'n8n-workflow';
import { resourceLocator, UUID_PLACEHOLDER } from './common';

const showForSend = { resource: ['email'], operation: ['send'] };

export const emailOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['email'] } },
	options: [
		{
			name: 'Send',
			value: 'send',
			action: 'Send a transactional email',
			description: 'Send one email to one recipient, from a template or from a subject and body',
		},
	],
	default: 'send',
};

export const emailFields: INodeProperties[] = [
	{
		displayName: 'To',
		name: 'to',
		type: 'string',
		placeholder: 'name@email.com',
		required: true,
		default: '',
		description:
			"The recipient's email address. One recipient per email; use CC or BCC to copy others. A new address is added to your contacts.",
		displayOptions: { show: showForSend },
	},
	{
		displayName: 'Content',
		name: 'content',
		type: 'options',
		default: 'template',
		displayOptions: { show: showForSend },
		options: [
			{
				name: 'Template',
				value: 'template',
				description: 'Send a template designed in Sendly',
			},
			{
				name: 'Subject and Body',
				value: 'custom',
				description: 'Write the subject and HTML body here',
			},
		],
	},
	resourceLocator({
		displayName: 'Template',
		name: 'template',
		searchListMethod: 'searchTemplates',
		description: 'The Sendly template to send',
		placeholder: UUID_PLACEHOLDER,
		show: { ...showForSend, content: ['template'] },
	}),
	{
		displayName: 'Subject',
		name: 'subject',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Your invoice for October',
		displayOptions: { show: { ...showForSend, content: ['custom'] } },
	},
	{
		displayName: 'Body (HTML)',
		name: 'body',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 6 },
		placeholder: '<p>Hi {{ first_name }}, your invoice is ready.</p>',
		description:
			"The HTML of the email. Variables such as {{ first_name }} are filled from Template Variables and the contact's custom fields.",
		displayOptions: { show: { ...showForSend, content: ['custom'] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showForSend },
		options: [
			{
				displayName: 'BCC',
				name: 'bcc',
				type: 'string',
				default: '',
				placeholder: 'e.g. audit@example.com, archive@example.com',
				description: 'Comma-separated email addresses to blind-copy',
			},
			{
				displayName: 'CC',
				name: 'cc',
				type: 'string',
				default: '',
				placeholder: 'e.g. manager@example.com',
				description: 'Comma-separated email addresses to copy',
			},
			{
				displayName: 'Deduplication Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				placeholder: 'e.g. {{ $json.orderId }}',
				description:
					'Map something unique to this send, such as an order ID. Sendly will not send the same key twice within 24 hours, even if the workflow is re-run. Leave empty and every execution sends.',
			},
			{
				displayName: 'From Email',
				name: 'from',
				type: 'string',
				default: '',
				placeholder: 'e.g. hello@yourdomain.com',
				description:
					"A sender on one of your verified domains. Leave empty to use the template's sender or the project's default transactional sender.",
			},
			{
				displayName: 'From Name',
				name: 'fromName',
				type: 'string',
				default: '',
				placeholder: 'e.g. Acme Billing',
			},
			{
				displayName: 'Reply To',
				name: 'replyTo',
				type: 'string',
				default: '',
				placeholder: 'e.g. support@yourdomain.com',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'e.g. invoice, october',
				description:
					'Comma-separated labels (letters, digits, - and _), up to 10, to filter emails by in Sendly and in the Sendly Trigger',
			},
			{
				displayName: 'Template Variables',
				name: 'data',
				type: 'json',
				default: '{}',
				description:
					"Values for the {{ variables }} in the subject and body, as a JSON object. Sendly also saves them on the recipient's contact.",
			},
			{
				displayName: 'To Name',
				name: 'toName',
				type: 'string',
				default: '',
				placeholder: 'e.g. Ada Lovelace',
			},
		],
	},
];
