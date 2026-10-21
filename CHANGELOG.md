# Changelog

## 0.1.0

First release.

- **Sendly API** credential: a project's secret API key, sent as `Authorization: Bearer`, tested with `GET /api/v1/projects`.
- **Sendly** node (programmatic, usable as an AI Agent tool):
  - Email: Send, from a template or a subject and body, with an `Idempotency-Key` on every send (derived from the execution, node, run and item, so Retry On Fail does not resend items already sent), an optional deduplication key, and one same-key retry on 5xx, 409 or a request that got no answer.
  - Contact: Create or Update (merges custom fields, never re-subscribes unless asked), Find by Email, Get, Get Many, Delete.
  - List: Add Contact, Remove Contact.
  - Campaign: Send, now or scheduled, with a derived `Idempotency-Key`.
  - Template, list and campaign dropdowns loaded from the project.
- **Sendly Trigger** node: registers a Sendly webhook for the chosen email and contact events, verifies the Standard Webhooks signature of every delivery, refuses deliveries signed more than 5 minutes from now, starts the workflow once per `webhook-id`, and can read the email or contact back after answering Sendly.
