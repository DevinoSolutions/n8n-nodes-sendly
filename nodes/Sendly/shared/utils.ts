import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';

/** Read a JSON parameter that may arrive as a string or as an already-parsed object. */
export function parseJsonObject(
	this: IExecuteFunctions,
	value: unknown,
	displayName: string,
	itemIndex: number,
): IDataObject | undefined {
	if (value === undefined || value === null || value === '') return undefined;

	let parsed: unknown = value;
	if (typeof value === 'string') {
		if (value.trim() === '') return undefined;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new NodeOperationError(
				this.getNode(),
				`The '${displayName}' parameter is not valid JSON`,
				{
					itemIndex,
					description: `Check the '${displayName}' value. It must be a JSON object, for example {"first_name": "Ada"}.`,
				},
			);
		}
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new NodeOperationError(
			this.getNode(),
			`The '${displayName}' parameter must be a JSON object`,
			{
				itemIndex,
				description: `Change the '${displayName}' value to a JSON object, for example {"first_name": "Ada"}.`,
			},
		);
	}
	return parsed as IDataObject;
}

/** Split a comma-separated list (or accept an array) into trimmed, non-empty strings. */
export function toStringList(value: unknown): string[] {
	const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
	return parts.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

/** Epoch values below this are seconds, above it milliseconds. */
const MS_THRESHOLD = 1e12;

/**
 * Reads a time (epoch seconds or milliseconds, as a number or a string, or a date string) as
 * ISO 8601 UTC, or null when it is absent or unreadable.
 */
export function toIsoOrNull(value: unknown): string | null {
	let date: Date | undefined;
	if (typeof value === 'number' && Number.isFinite(value)) {
		date = new Date(value < MS_THRESHOLD ? value * 1000 : value);
	} else if (typeof value === 'string' && value.trim() !== '') {
		const trimmed = value.trim();
		if (/^\d+$/.test(trimmed)) {
			const numeric = Number(trimmed);
			date = new Date(numeric < MS_THRESHOLD ? numeric * 1000 : numeric);
		} else {
			date = new Date(trimmed);
		}
	} else if (value instanceof Date) {
		date = value;
	}
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}
