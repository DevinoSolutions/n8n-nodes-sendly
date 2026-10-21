# n8n-nodes-sendly

This is an n8n community node for [Sendly](https://sendly.now), the email platform by Devino Solutions. It lets you send transactional emails and campaigns from your n8n workflows, keep contacts and list members in sync, and start workflows when an email is opened, clicked, bounced or delivered, or when a contact is created or unsubscribes.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Trigger](#trigger)
- [Usage examples](#usage-examples)
- [Use as an AI Agent tool](#use-as-an-ai-agent-tool)
- [Compatibility](#compatibility)
- [Development](#development)
- [Publishing (owner step)](#publishing-owner-step)
- [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

1. In n8n, go to **Settings > Community Nodes**.
2. Select **Install**.
3. Enter `n8n-nodes-sendly` as the npm package name.
4. Accept the risks of using community nodes and select **Install**.

After installation, search for **Sendly** in the nodes panel. The package adds two nodes:

- **Sendly**: actions on emails, contacts, lists and campaigns.
- **Sendly Trigger**: starts a workflow when Sendly sends a webhook for an email or contact event.

## Credentials

The nodes authenticate with a secret API key of a Sendly project. A key belongs to one project, and every call runs against that project.

1. Sign in to [Sendly](https://app.sendly.now).
2. Open **Settings > API keys** and create a **secret** key (it starts with `sk_`).
3. In n8n, create a new **Sendly API** credential and paste the key into **Secret API Key**.

n8n checks the credential with `GET https://api.sendly.now/api/v1/projects`, which names the project the key belongs to. The key is sent as the `Authorization: Bearer <key>` header.

- A **Full access** key covers every operation. A custom key needs `projects:read`, `contacts:read`, `contacts:write`, `lists:read`, `emails:read`, `emails:send`, `templates:read`, `campaigns:read`, `campaigns:send`, `webhooks:read` and `webhooks:write`.
- A **publishable** key (`pk_`) can only send email, so the credential test refuses it.
- A **test** key (`sk_test_`) sends only from the project's sandbox address to your own address, and cannot send campaigns. Use one while you build a workflow.

**Costs.** API requests are not billed (the limit is 10 requests per second per key). Every email a workflow sends counts toward the project's email volume: 5,000 a month without a subscription, then metered. New projects also have a daily sending ceiling.

## Operations

### Email

| Operation | What it does | Sendly API |
| --- | --- | --- |
| Send | Send one email to one recipient, from a Sendly template or from a subject and HTML body. Optional: recipient name, sender and sender name, reply-to, CC, BCC, tags, template variables and a deduplication key. | `POST /api/v1/emails` |

Every send carries an `Idempotency-Key` header. Without a **Deduplication Key** each execution gets a fresh key, and the node retries once with the same key after a 5xx or a 409, so a retry never sends twice. Map something unique to the send (an order ID, say) into **Deduplication Key** and Sendly will not send it again for 24 hours, even if the workflow re-runs the same item.

The answer is the send receipt: the email ID, the sender actually used, and a status that is usually `PENDING`. Delivery, opens and clicks arrive later through the **Sendly Trigger**.

### Contact

| Operation | What it does | Sendly API |
| --- | --- | --- |
| Create or Update | Create a contact, or update the existing contact with the same email address. Custom fields are merged with the stored ones unless **Replace Custom Fields** is on. The subscription is changed only when you set **Subscribed**, so a workflow never re-subscribes someone by accident. The output has `created: true` or `false`. | `POST /api/v1/contacts`, then on 409 `GET /api/v1/contacts?search=` and `PATCH /api/v1/contacts/{id}` |
| Find by Email | Find the contact with an exact email address (letter case is ignored). No match returns no item. | `GET /api/v1/contacts?search=` |
| Get | Retrieve a contact by ID. | `GET /api/v1/contacts/{id}` |
| Get Many | List contacts, newest first, filtered by "email contains" and subscription, with Return All or a limit. | `GET /api/v1/contacts` |
| Delete | Delete a contact. Emails already sent to it are kept. | `DELETE /api/v1/contacts/{id}` |

### List

| Operation | What it does | Sendly API |
| --- | --- | --- |
| Add Contact | Add an email address to a list, creating the contact if needed, with optional custom fields. Someone who unsubscribed from the list is only re-added when **Allow Resubscribe** is on. On a double opt-in list the membership is `PENDING` and the output carries the `confirmToken`; Sendly does not send the confirmation email itself. | `POST /api/lists/{id}/subscribe` |
| Remove Contact | Unsubscribe an email address from a list. The contact itself is kept. | `POST /api/lists/{id}/unsubscribe` |

### Campaign

| Operation | What it does | Sendly API |
| --- | --- | --- |
| Send | Send a draft or scheduled campaign to its whole audience, now or at a future **Send At**. The campaign's content and audience are set in Sendly. Each campaign sends once, and the `Idempotency-Key` is derived from the campaign and the time, so a re-run never sends twice. | `POST /api/v1/campaigns/{id}/send` |

**Template**, **List** and **Campaign** are dropdowns loaded from your project (the Campaign dropdown shows only draft and scheduled campaigns). You can also switch them to **By ID**.

## Trigger

**Sendly Trigger** registers a webhook in your Sendly project when the workflow is activated, and deletes it when the workflow is deactivated. You pick one or more events:

| Event | Fires when |
| --- | --- |
| Email Sent | Sendly hands an email to the sending provider |
| Email Delivered | The recipient's mail server accepts it |
| Email Opened | A recipient opens it (every open, re-opens included) |
| Email Clicked | A recipient clicks a tracked link |
| Email Bounced | It hard-bounces |
| Email Complained | A recipient marks it as spam |
| Email Failed | It could not be sent |
| Contact Created | A contact is added one at a time (contacts created in one bulk request do not fire it) |
| Contact Unsubscribed | A contact unsubscribes |

- **Signatures are verified.** Sendly signs every delivery with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256). The node keeps the signing secret Sendly returns when the webhook is created and answers `401` to any request whose signature does not match, without starting the workflow. Both signatures sent during a secret rotation are accepted.
- **Each item** has `event`, `event_id` (the delivery's `webhook-id`, stable across Sendly's retries), `occurred_at`, `test`, and the raw event `data`.
- **Include Details** (on by default) reads the email (`GET /api/emails/{id}`) or the contact (`GET /api/v1/contacts/{id}`) back from Sendly, so the item carries the recipient, subject, status and counts, or the custom fields. Turn it off to save that API read.
- A dashboard **Send test** delivery is passed through with `test: true` and no details.
- If you rotate the webhook's secret in Sendly, deactivate and re-activate the workflow so the node registers a fresh webhook.

## Usage examples

**Send a receipt when an order is paid.** Start with your shop's trigger, then add a **Sendly** node: Resource **Email**, Operation **Send**, **To** `{{ $json.customer.email }}`, **Content** Template, pick your receipt template, and under **Additional Fields** set **Template Variables** to `{ "order_id": "{{ $json.id }}", "total": "{{ $json.total }}" }` and **Deduplication Key** to `{{ $json.id }}`.

**Keep your CRM and Sendly in sync.** On a new CRM contact, run **Contact > Create or Update** with the email and the CRM fields as **Custom Fields**, then **List > Add Contact** to put them on the matching list.

**Act on engagement.** Start with **Sendly Trigger** on **Email Clicked** and send the click to Slack, or on **Email Bounced** and flag the address in your CRM.

## Use as an AI Agent tool

The **Sendly** node can be used as a tool by n8n's AI Agent node, for example to look up a contact or send a templated email. Connect it to the agent's **Tool** input and describe in the tool description what the agent may do. Prefer a test key while you try this out.

## Compatibility

- Built with the `@n8n/node-cli` scaffold, n8n Nodes API version 1, strict mode.
- Tested with n8n 2.x. AI Agent tool use needs an n8n version that supports `usableAsTool`.
- No runtime dependencies (only `n8n-workflow` as a peer dependency and Node's built-in `crypto`).

## Development

```bash
npm install
npm run lint     # n8n community-node lint (strict)
npm test         # type-checks the tests, then runs them with mocked HTTP
npm run build
npm run dev      # starts a local n8n with the node loaded
```

The tests never touch the network: every Sendly response is a canned answer, and each test checks the exact request the node sends.

## Publishing (owner step)

The package is built and tested but not published. These steps remain, and each needs the owner:

1. **Public GitHub repository** `DevinoSolutions/n8n-nodes-sendly` (MIT), matching `repository` in `package.json`. n8n checks that the npm package links to a real public repository.
2. **npm token**: for the first release only, a short-lived granular npm token with publish rights, stored as the `NPM_TOKEN` repository secret. npm cannot attach a trusted publisher to a package that does not exist yet.
3. **Provenance publish**: push a version tag (for example `0.1.0`); `.github/workflows/publish.yml` publishes with an npm provenance statement, which n8n requires for verified nodes since May 1, 2026. Then configure npm Trusted Publishing for `publish.yml`, delete the `NPM_TOKEN` secret and revoke the token.
4. **n8n verification**: submit the published package in the [n8n Creator Portal](https://creators.n8n.io/nodes) so it becomes installable from the nodes panel and on n8n Cloud.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Sendly](https://sendly.now)
- [Sendly API documentation](https://docs.sendly.now)
- [Sendly API reference (OpenAPI)](https://docs.sendly.now/openapi.json)

## License

[MIT](LICENSE.md)
