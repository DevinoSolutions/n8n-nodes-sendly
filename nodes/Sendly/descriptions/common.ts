import type { INodeProperties } from 'n8n-workflow';

export type DisplayShow = NonNullable<NonNullable<INodeProperties['displayOptions']>['show']>;

/** A "From List / By ID" picker backed by one of the node's listSearch methods. */
export function resourceLocator(options: {
	displayName: string;
	name: string;
	searchListMethod: string;
	description: string;
	placeholder: string;
	show: DisplayShow;
	required?: boolean;
}): INodeProperties {
	return {
		displayName: options.displayName,
		name: options.name,
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: options.required ?? true,
		description: options.description,
		displayOptions: { show: options.show },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: `Select a ${options.displayName.toLowerCase()}...`,
				typeOptions: {
					searchListMethod: options.searchListMethod,
					searchable: true,
				},
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: options.placeholder,
			},
		],
	};
}

export const emailField = (show: DisplayShow, description: string): INodeProperties => ({
	displayName: 'Email',
	name: 'email',
	type: 'string',
	placeholder: 'name@email.com',
	required: true,
	default: '',
	description,
	displayOptions: { show },
});

export const UUID_PLACEHOLDER = 'e.g. 7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
