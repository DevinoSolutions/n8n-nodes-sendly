import type { INodeProperties } from 'n8n-workflow';
import { emailField, resourceLocator, UUID_PLACEHOLDER } from './common';

export const listOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['list'] } },
	options: [
		{
			name: 'Add Contact',
			value: 'addContact',
			action: 'Add a contact to a list',
			description: 'Add an email address to a list, creating the contact if it does not exist',
		},
		{
			name: 'Remove Contact',
			value: 'removeContact',
			action: 'Remove a contact from a list',
			description: 'Unsubscribe an email address from a list. The contact itself is kept.',
		},
	],
	default: 'addContact',
};

export const listFields: INodeProperties[] = [
	resourceLocator({
		displayName: 'List',
		name: 'listId',
		searchListMethod: 'searchLists',
		description: 'The Sendly list to change',
		placeholder: UUID_PLACEHOLDER,
		show: { resource: ['list'] },
	}),
	emailField({ resource: ['list'] }, 'The email address of the contact'),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['list'], operation: ['addContact'] } },
		options: [
			{
				displayName: 'Allow Resubscribe',
				name: 'allowResubscribe',
				type: 'boolean',
				default: false,
				description:
					'Whether to re-add someone who unsubscribed from this list. Only turn this on when the person asked to be re-subscribed. Off, Sendly refuses with a conflict error.',
			},
			{
				displayName: 'Custom Fields',
				name: 'customFields',
				type: 'json',
				default: '{}',
				description: 'Fields to save on the contact while adding it, as a JSON object',
			},
		],
	},
];
