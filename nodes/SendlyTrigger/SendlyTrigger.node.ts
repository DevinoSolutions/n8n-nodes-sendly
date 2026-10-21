import {
	NodeConnectionTypes,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { sendlyRequest, throwApiError } from '../Sendly/shared/transport';
import { toIsoOrNull } from '../Sendly/shared/utils';
import { readHeader, signatureMatches } from './signature';

/** The event types Sendly's POST /api/v1/webhooks accepts that this trigger offers. */
export const EVENT_OPTIONS = [
	{
		name: 'Contact Created',
		value: 'contact.created',
		description:
			'A contact is added one at a time, including by a send to a new address. Contacts created in one bulk request do not trigger it.',
	},
	{
		name: 'Contact Unsubscribed',
		value: 'contact.unsubscribed',
		description: 'A contact unsubscribes from marketing email',
	},
	{
		name: 'Email Bounced',
		value: 'email.bounced',
		description: 'An email hard-bounces: the address is permanently undeliverable',
	},
	{
		name: 'Email Clicked',
		value: 'email.clicked',
		description: 'A recipient clicks a tracked link in an email',
	},
	{
		name: 'Email Complained',
		value: 'email.complained',
		description: 'A recipient marks an email as spam',
	},
	{
		name: 'Email Delivered',
		value: 'email.delivered',
		description: "The recipient's mail server accepts an email",
	},
	{
		name: 'Email Failed',
		value: 'email.failed',
		description: 'An email could not be sent',
	},
	{
		name: 'Email Opened',
		value: 'email.opened',
		description: 'A recipient opens an email. Every open counts, re-opens included.',
	},
	{
		name: 'Email Sent',
		value: 'email.sent',
		description: 'Sendly hands an email to the sending provider',
	},
];

interface WebhookState extends IDataObject {
	webhookId?: string;
	webhookSecret?: string;
}

interface Envelope {
	event?: string;
	data?: IDataObject;
	timestamp?: string | number;
}

interface WebhookRecord {
	id: string;
	url: string;
	event_types: string[];
	status: string;
}

function sameEvents(left: string[], right: string[]): boolean {
	const a = [...new Set(left)].sort();
	const b = [...new Set(right)].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class SendlyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Sendly Trigger',
		name: 'sendlyTrigger',
		icon: { light: 'file:../../icons/sendly.svg', dark: 'file:../../icons/sendly.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when Sendly sends a webhook for an email or contact event',
		defaults: {
			name: 'Sendly Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'sendlyApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				options: EVENT_OPTIONS,
				description: 'The Sendly events that start the workflow',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Details',
						name: 'includeDetails',
						type: 'boolean',
						default: true,
						description:
							'Whether to read the email or contact back from Sendly, so the item carries the recipient, subject, status and counts (or the custom fields). Each event then costs one API read.',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as WebhookState;
				if (!state.webhookId || !state.webhookSecret) return false;

				const response = await sendlyRequest.call(this, {
					method: 'GET',
					path: `/api/v1/webhooks/${encodeURIComponent(state.webhookId)}`,
				});
				if (response.statusCode === 404) {
					delete state.webhookId;
					delete state.webhookSecret;
					return false;
				}
				if (response.statusCode >= 400) {
					throwApiError.call(this, response, 'Could not check the Sendly webhook:');
				}

				const webhook = response.body as WebhookRecord;
				if (webhook.url !== this.getNodeWebhookUrl('default')) return false;

				const events = this.getNodeParameter('events', []) as string[];
				if (webhook.status === 'ACTIVE' && sameEvents(webhook.event_types ?? [], events)) {
					return true;
				}
				// Same URL but other events, or paused/disabled after repeated failures: replace it.
				await sendlyRequest.call(this, {
					method: 'DELETE',
					path: `/api/v1/webhooks/${encodeURIComponent(state.webhookId)}`,
				});
				delete state.webhookId;
				delete state.webhookSecret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const events = this.getNodeParameter('events', []) as string[];
				const response = await sendlyRequest.call(this, {
					method: 'POST',
					path: '/api/v1/webhooks',
					body: { url: this.getNodeWebhookUrl('default'), event_types: events },
				});
				if (response.statusCode >= 400) {
					throwApiError.call(
						this,
						response,
						'Sendly refused to register the webhook this trigger needs:',
					);
				}
				const created = response.body as { webhook?: { id?: string }; secret?: string };
				if (!created.webhook?.id || !created.secret) return false;

				// The signing secret is shown once, by this response only; it is kept to verify
				// every delivery.
				const state = this.getWorkflowStaticData('node') as WebhookState;
				state.webhookId = created.webhook.id;
				state.webhookSecret = created.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as WebhookState;
				if (!state.webhookId) return true;

				const response = await sendlyRequest.call(this, {
					method: 'DELETE',
					path: `/api/v1/webhooks/${encodeURIComponent(state.webhookId)}`,
				});
				// 404: already deleted in Sendly under Settings > Webhooks, which is the goal.
				if (response.statusCode >= 400 && response.statusCode !== 404) return false;
				delete state.webhookId;
				delete state.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const state = this.getWorkflowStaticData('node') as WebhookState;
		const request = this.getRequestObject();
		const headers = this.getHeaderData() as Record<string, string | string[] | undefined>;
		const rawBody: unknown = (request as { rawBody?: unknown }).rawBody;
		const body = Buffer.isBuffer(rawBody)
			? rawBody.toString('utf8')
			: typeof rawBody === 'string'
				? rawBody
				: undefined;

		const id = readHeader(headers, 'webhook-id');
		const timestamp = readHeader(headers, 'webhook-timestamp');
		const signature = readHeader(headers, 'webhook-signature');
		const verified =
			!!state.webhookSecret &&
			body !== undefined &&
			!!id &&
			!!timestamp &&
			!!signature &&
			signatureMatches({
				secret: state.webhookSecret,
				id,
				timestamp,
				body,
				signatureHeader: signature,
			});

		if (!verified) {
			// A forged or stale request: refuse it without starting the workflow.
			const response = this.getResponseObject();
			response.status(401).json({ error: 'Invalid Sendly webhook signature' });
			return { noWebhookResponse: true };
		}

		const envelope = this.getBodyData() as Envelope;
		const events = this.getNodeParameter('events', []) as string[];
		if (!envelope.event || !events.includes(envelope.event)) {
			return {};
		}

		const data = (envelope.data ?? {}) as IDataObject;
		const isTest = data.test === true;
		const output: IDataObject = {
			event: envelope.event,
			event_id: id,
			occurred_at:
				toIsoOrNull(data.ts) ?? toIsoOrNull(data.timestamp) ?? toIsoOrNull(envelope.timestamp),
			test: isTest,
			data,
		};

		const options = this.getNodeParameter('options', {}) as IDataObject;
		if (options.includeDetails !== false && !isTest) {
			if (envelope.event.startsWith('email.') && typeof data.emailId === 'string') {
				const email = await sendlyRequest.call(this, {
					method: 'GET',
					path: `/api/emails/${encodeURIComponent(data.emailId)}`,
				});
				output.email =
					email.statusCode < 400
						? (((email.body as IDataObject).data as IDataObject) ?? null)
						: null;
			} else if (envelope.event.startsWith('contact.') && typeof data.contactId === 'string') {
				const contact = await sendlyRequest.call(this, {
					method: 'GET',
					path: `/api/v1/contacts/${encodeURIComponent(data.contactId)}`,
				});
				output.contact = contact.statusCode < 400 ? (contact.body as IDataObject) : null;
			}
		}

		return { workflowData: [this.helpers.returnJsonArray([output])] };
	}
}
