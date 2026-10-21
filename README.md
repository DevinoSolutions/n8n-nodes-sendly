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

Every send carries an `Idempotency-Key` header, and Sendly answers a repeated key with the first send's receipt for 24 hours instead of sending again. What that protects depends on the key:

- **Without a Deduplication Key** the key is derived from where the send sits in n8n: the instance, workflow, execution, node, run of the node and input item.
  - The node's own retry (once, with the same key, after a 5xx, a 409 or a request that got no answer) never sends twice.
  - n8n's **Retry On Fail** re-runs the whole node, every item included, inside the same execution, so items already sent get their first receipt back instead of a second email.
  - A loop, or an AI Agent calling the node again, is a new run of the node and sends again, as intended.
  - A manual **Retry** of a failed execution (from the executions list), or running the workflow again, is a new execution with a new ID. Items that were sent before the failure **are sent again**. Only a Deduplication Key prevents that.
- **With a Deduplication Key** (an order ID, say) the key is the same in every execution, so Sendly will not send it again for 24 hours, whatever re-runs the item. The key names the email, not its content: a second send under the same key with a different body (another recipient, other variables) is refused with an error and not sent. Map something unique to each email, not to the customer.

If the body itself changes between tries of the same item (for example it maps `$now`), Sendly also refuses the reused derived key rather than send a second, different email.

The answer is the send receipt: the email ID, the sender actually used, and a status that is usually `PENDING`. Delivery, opens and clicks arrive later through the **Sendly Trigger**.

### Contact

| Operation | What it does | Sendly API |
| --- | --- | --- |
| Create or Update | Create a contact, or update the existing contact with the same email address. Custom fields are merged with the stored ones unless **Replace Custom Fields** is on. The subscription is changed only when you set **Subscribed**, so a workflow never re-subscribes someone by accident. The output has `created: true` or `false`. Merging is a read, then a write: two runs updating the same email address at the same moment can each read the old fields, and the later write drops the other's change. Send updates for one contact through one run at a time when that matters. | `POST /api/v1/contacts`, then on 409 `GET /api/v1/contacts?search=` and `PATCH /api/v1/contacts/{id}` |
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
| Send | Send a draft or scheduled campaign to its whole audience, now or at a future **Send At**. The campaign's content and audience are set in Sendly. Each campaign sends once: Sendly refuses to send a campaign that is no longer a draft or scheduled, so a re-run, a retry or a manual retry of the execution never sends it twice. The `Idempotency-Key` is derived from the campaign and **Send At**, so a retry that races the first request gets its answer instead of an error. | `POST /api/v1/campaigns/{id}/send` |

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

- **Signatures are verified.** Sendly signs every delivery with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256). The node answers `401` to any request whose signature does not match, without starting the workflow. Both signatures sent during a secret rotation are accepted.
- **Replays are refused.** Sendly signs each attempt, retries included, with the time of that attempt, so the node also answers `401` to a delivery whose signed timestamp is more than 5 minutes from the n8n server's clock. Keep that clock synchronised (NTP).
- **Each event starts the workflow once.** Sendly retries a delivery until it gets a `2xx`, with the same `webhook-id`. The node remembers the last 200 delivery IDs and answers a repeat with `200` without starting the workflow.
- **Where the secret lives.** Sendly shows the signing secret once, when the webhook is created. The node keeps it, with the webhook ID and the recent delivery IDs, in the workflow's static data, which n8n stores with the workflow in its database, as it does for its own trigger nodes. Anyone who can read the workflow's database row can read the secret. **Listen for test event** registers a separate webhook for the test URL, with its own secret that n8n holds only for the test session, so it never touches an active workflow's webhook.
- **Each item** has `event`, `event_id` (the delivery's `webhook-id`, stable across Sendly's retries), `occurred_at`, `test`, and the raw event `data`.
- **Include Details** (on by default) reads the email (`GET /api/emails/{id}`) or the contact (`GET /api/v1/contacts/{id}`) back from Sendly, so the item carries the recipient, subject, status and counts, or the custom fields. The node answers Sendly's request before that read, so the read never delays the answer. If the read fails, the item is still emitted with the detail set to `null`. Turn it off to save that API read.
- A dashboard **Send test** delivery is passed through with `test: true` and no details.
- If you rotate the webhook's secret in Sendly, deactivate and re-activate the workflow so the node registers a fresh webhook.
- On activation the node replaces a webhook it registered earlier if its URL (n8n's base URL changed), its events or its status (Sendly disabled it after repeated failures) no longer match, deleting the old one in Sendly first.

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
