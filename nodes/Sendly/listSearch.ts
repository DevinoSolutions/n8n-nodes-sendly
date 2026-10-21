import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import type { CursorPage } from './shared/contacts';
import { sendlyApiRequest } from './shared/transport';

const PAGE_SIZE = 100;

interface Named extends IDataObject {
	id: string;
	name: string;
}

interface Campaign extends Named {
	status: string;
}

/** The only campaign states POST /api/v1/campaigns/{id}/send accepts. */
export const SENDABLE_CAMPAIGN_STATUSES = new Set(['DRAFT', 'SCHEDULED']);

async function listPage<T extends IDataObject>(
	context: ILoadOptionsFunctions,
	path: string,
	paginationToken: string | undefined,
	extraQs: IDataObject = {},
): Promise<CursorPage<T>> {
	const qs: IDataObject = { limit: PAGE_SIZE, ...extraQs };
	if (paginationToken) qs.after = paginationToken;
	return (await sendlyApiRequest.call(context, {
		method: 'GET',
		path,
		qs,
	})) as unknown as CursorPage<T>;
}

function matches(name: string, filter: string | undefined): boolean {
	return !filter || name.toLowerCase().includes(filter.trim().toLowerCase());
}

/** Subscriber lists for the List field (GET /api/v1/lists, filtered by name here). */
export async function searchLists(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = await listPage<Named>(this, '/api/v1/lists', paginationToken);
	const results: INodeListSearchItems[] = (page.data ?? [])
		.filter((list) => matches(list.name, filter))
		.map((list) => ({ name: list.name, value: list.id }));
	return { results, paginationToken: page.has_more ? (page.next_cursor ?? undefined) : undefined };
}

/** Templates for the Template field (GET /api/v1/templates supports a name search). */
export async function searchTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const search = filter?.trim();
	const page = await listPage<Named>(
		this,
		'/api/v1/templates',
		paginationToken,
		search ? { search } : {},
	);
	const results: INodeListSearchItems[] = (page.data ?? []).map((template) => ({
		name: template.name,
		value: template.id,
	}));
	return { results, paginationToken: page.has_more ? (page.next_cursor ?? undefined) : undefined };
}

/** Draft and scheduled campaigns for the Campaign field (the route has no status filter). */
export async function searchCampaigns(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = await listPage<Campaign>(this, '/api/v1/campaigns', paginationToken);
	const results: INodeListSearchItems[] = (page.data ?? [])
		.filter((campaign) => SENDABLE_CAMPAIGN_STATUSES.has(campaign.status))
		.filter((campaign) => matches(campaign.name, filter))
		.map((campaign) => ({
			name: campaign.status === 'SCHEDULED' ? `${campaign.name} (scheduled)` : campaign.name,
			value: campaign.id,
		}));
	return { results, paginationToken: page.has_more ? (page.next_cursor ?? undefined) : undefined };
}
