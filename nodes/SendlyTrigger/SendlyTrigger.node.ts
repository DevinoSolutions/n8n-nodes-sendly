import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { sendlyRequest, throwApiError } from '../Sendly/shared/transport';
import { toIsoOrNull } from '../Sendly/shared/utils';
import { readHeader, signatureMatches, timestampIsFresh } from './signature';

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

/**
 * What the node keeps in the workflow's static data: the Sendly webhook it registered, the
 * signing secret Sendly shows once when the webhook is created (n8n's own trigger nodes keep
 * their webhook IDs and secrets the same way), and the IDs of the last deliveries it accepted.
 *
 * n8n keeps this per mode. A production activation reads and writes the workflow's saved static
 * data. "Listen for test event" starts from empty static data that n8n holds with the test
 * registration only (TestWebhooks.toWorkflow / setTestStaticData), so a test listen on an
 * active workflow registers its own webhook for the test URL and never sees, replaces or
 * deletes the production webhook's ID or secret.
 */
interface WebhookState extends IDataObject {
	webhookId?: string;
	webhookSecret?: string;
	deliveryIds?: string[];
}

/** How many accepted delivery IDs are remembered to drop Sendly's retries of the same event. */
export const REMEMBERED_DELIVERIES = 200;

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

/** DELETE a registered webhook; a 404 means it is already gone, which is the goal. */
async function removeWebhook(this: IHookFunctions, webhookId: string): Promise<void> {
	const response = await sendlyRequest.call(this, {
		method: 'DELETE',
		path: `/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
	});
	if (response.statusCode >= 400 && response.statusCode !== 404) {
		throwApiError.call(this, response, 'Could not remove the outdated Sendly webhook:');
	}
}

/** Reads an email or contact back from Sendly; any failure leaves the detail empty. */
async function readBack(this: IWebhookFunctions, path: string): Promise<IDataObject | null> {
	try {
		const response = await sendlyRequest.call(this, { method: 'GET', path });
		return response.statusCode < 400 ? (response.body as IDataObject) : null;
	} catch {
		return null;
	}
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
				const events = this.getNodeParameter('events', []) as string[];
				if (
					webhook.url === this.getNodeWebhookUrl('default') &&
					webhook.status === 'ACTIVE' &&
					sameEvents(webhook.event_types ?? [], events)
				) {
					return true;
				}
				// Another URL (n8n's base URL changed), other events, or paused/disabled after
				// repeated failures: remove it before `create` registers the replacement, so the old
				// one stops posting this project's events to a URL nobody verifies.
				await removeWebhook.call(this, state.webhookId);
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
				if (!created.webhook?.id || !created.secret) {
					// Without the secret no delivery can be verified, so a webhook kept now would only
					// post requests this node refuses. Remove it, and fail the activation loudly: n8n
					// ignores what `create` returns, so `false` would leave a dead trigger "active".
					if (created.webhook?.id) await removeWebhook.call(this, created.webhook.id);
					throw new NodeOperationError(
						this.getNode(),
						'Sendly registered the webhook without returning its signing secret',
						{ description: 'The webhook was removed again. Activate the workflow again.' },
					);
				}

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

		if (!verified || !id || !timestamp) {
			// A forged request: refuse it without starting the workflow.
			this.getResponseObject().status(401).json({ error: 'Invalid Sendly webhook signature' });
			return { noWebhookResponse: true };
		}
		// Sendly signs every attempt, its retries included, with the time of that attempt
		// (WebhookSigning.buildSignatureHeaders is called with `now` on each try), so a genuine
		// delivery is never older than its trip over the network. One signed more than five
		// minutes away from now is a captured request played back.
		if (!timestampIsFresh(timestamp)) {
			this.getResponseObject().status(401).json({ error: 'Stale Sendly webhook timestamp' });
			return { noWebhookResponse: true };
		}

		const envelope = this.getBodyData() as Envelope;
		const events = this.getNodeParameter('events', []) as string[];
		if (!envelope.event || !events.includes(envelope.event)) {
			return {};
		}

		// Sendly re-sends an event until it gets a 2xx, with the same `webhook-id` each time. One
		// already accepted is answered 200 and starts nothing. The list is replaced rather than
		// pushed to, so n8n sees the change and saves it. Two copies arriving at the same instant
		// can both pass (each request reads the saved list), which Sendly's retry spacing (30
		// seconds and up) makes rare.
		const seen = Array.isArray(state.deliveryIds) ? state.deliveryIds : [];
		if (seen.includes(id)) {
			return { webhookResponse: { received: true, duplicate: true } };
		}
		state.deliveryIds = [...seen, id].slice(-REMEMBERED_DELIVERIES);

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
		const emailId =
			envelope.event.startsWith('email.') && typeof data.emailId === 'string'
				? data.emailId
				: undefined;
		const contactId =
			envelope.event.startsWith('contact.') && typeof data.contactId === 'string'
				? data.contactId
				: undefined;
		if (options.includeDetails === false || isTest || (!emailId && !contactId)) {
			return { workflowData: [this.helpers.returnJsonArray([output])] };
		}

		// The read-back is one more API call. In the "onReceived" response mode n8n answers only
		// after this method returns, and Sendly abandons an attempt after 10 seconds and retries
		// it, so the node sends the 200 itself first; `noWebhookResponse` then stops n8n from
		// answering a second time. The delivery ID is recorded above, so a retry that still raced
		// this answer would start nothing. Read-back failures leave the detail empty and never
		// throw, because the answer is already sent.
		this.getResponseObject().status(200).json({ received: true });
		if (emailId) {
			const email = await readBack.call(this, `/api/emails/${encodeURIComponent(emailId)}`);
			output.email = (email?.data as IDataObject | undefined) ?? null;
		} else if (contactId) {
			output.contact = await readBack.call(
				this,
				`/api/v1/contacts/${encodeURIComponent(contactId)}`,
			);
		}

		return {
			noWebhookResponse: true,
			workflowData: [this.helpers.returnJsonArray([output])],
		};
	}
}
