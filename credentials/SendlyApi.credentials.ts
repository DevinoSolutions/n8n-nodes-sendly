import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SendlyApi implements ICredentialType {
	name = 'sendlyApi';

	displayName = 'Sendly API';

	icon: Icon = { light: 'file:../icons/sendly.svg', dark: 'file:../icons/sendly.dark.svg' };

	documentationUrl =
		'https://github.com/DevinoSolutions/n8n-nodes-sendly?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Secret API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'sk_...',
			description:
				'A secret key (starting with sk_) from Sendly under Settings > API keys. A key belongs to one project. Publishable keys (pk_) can only send email and fail the connection test.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.sendly.now',
			url: '/api/v1/projects',
			method: 'GET',
		},
	};
}
