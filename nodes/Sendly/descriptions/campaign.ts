import type { INodeProperties } from 'n8n-workflow';
import { resourceLocator, UUID_PLACEHOLDER } from './common';

export const campaignOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['campaign'] } },
	options: [
		{
			name: 'Send',
			value: 'send',
			action: 'Send a campaign',
			description: 'Send a draft campaign to its whole audience, now or at a set time',
		},
	],
	default: 'send',
};

export const campaignFields: INodeProperties[] = [
	resourceLocator({
		displayName: 'Campaign',
		name: 'campaignId',
		searchListMethod: 'searchCampaigns',
		description:
			'A draft or scheduled campaign, written and given its audience in Sendly. It goes to every recipient and cannot be unsent. Each campaign sends once.',
		placeholder: UUID_PLACEHOLDER,
		show: { resource: ['campaign'], operation: ['send'] },
	}),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['campaign'], operation: ['send'] } },
		options: [
			{
				displayName: 'Send At',
				name: 'scheduledFor',
				type: 'dateTime',
				default: '',
				description:
					"When to send, in the future. Leave this field out to send now. A time without a UTC offset is read in the n8n server's time zone.",
			},
		],
	},
];
