import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type JsonObject,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { handlers } from './actions';
import { campaignFields, campaignOperations } from './descriptions/campaign';
import { contactFields, contactOperations } from './descriptions/contact';
import { emailFields, emailOperations } from './descriptions/email';
import { listFields, listOperations } from './descriptions/list';
import { searchCampaigns, searchLists, searchTemplates } from './listSearch';

/*
 * Programmatic style, not declarative: Create or Update is up to three dependent calls
 * (create, then on 409 find and patch with merged custom fields), and the two sends retry once
 * with the same Idempotency-Key on a 5xx or 409, which routing rules cannot express.
 */
export class Sendly implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Sendly',
		name: 'sendly',
		icon: { light: 'file:../../icons/sendly.svg', dark: 'file:../../icons/sendly.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Send transactional emails and campaigns, and manage contacts and list members in Sendly',
		defaults: {
			name: 'Sendly',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'sendlyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Campaign',
						value: 'campaign',
						description: 'Marketing emails written in Sendly and sent to an audience',
					},
					{
						name: 'Contact',
						value: 'contact',
						description: 'People in your Sendly project',
					},
					{
						name: 'Email',
						value: 'email',
						description: 'Transactional emails to one recipient',
					},
					{
						name: 'List',
						value: 'list',
						description: 'Subscriber lists',
					},
				],
				default: 'email',
			},
			emailOperations,
			contactOperations,
			listOperations,
			campaignOperations,
			...emailFields,
			...contactFields,
			...listFields,
			...campaignFields,
		],
	};

	methods = {
		listSearch: {
			searchCampaigns,
			searchLists,
			searchTemplates,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const handler = handlers[resource]?.[operation];
				if (!handler) {
					throw new NodeOperationError(
						this.getNode(),
						`The operation '${operation}' is not supported for '${resource}'`,
						{ itemIndex },
					);
				}

				const result = await handler.call(this, itemIndex);
				const results: IDataObject[] = Array.isArray(result) ? result : [result];
				returnData.push(
					...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(results), {
						itemData: { item: itemIndex },
					}),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				// Errors from the request helpers are already NodeApiError or NodeOperationError, and
				// both constructors hand those back unchanged; anything else gets wrapped.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
