type ErrorRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorRecord {
    return typeof value === 'object' && value !== null;
}

function getStringProperty(value: ErrorRecord, key: string): string | undefined {
    const property = value[key];
    return typeof property === 'string' ? property : undefined;
}

function getNumberProperty(value: ErrorRecord, key: string): number | undefined {
    const property = value[key];
    return typeof property === 'number' ? property : undefined;
}

export function getErrorMessage(error: unknown, fallback = ''): string {
    if (error instanceof Error) return error.message || fallback;
    if (typeof error === 'string') return error || fallback;
    if (isRecord(error)) return getStringProperty(error, 'message') || fallback;
    return fallback;
}

export function getErrorStack(error: unknown): string | undefined {
    if (error instanceof Error) return error.stack;
    if (isRecord(error)) return getStringProperty(error, 'stack');
    return undefined;
}

export function getErrorName(error: unknown): string | undefined {
    if (error instanceof Error) return error.name;
    if (isRecord(error)) return getStringProperty(error, 'name');
    return undefined;
}

export function getErrorStatus(error: unknown): number | undefined {
    if (!isRecord(error)) return undefined;
    return getNumberProperty(error, 'status');
}

export function getErrorData(error: unknown): unknown {
    if (!isRecord(error)) return undefined;
    return error.data;
}

export function getErrorDataMessage(error: unknown): string | undefined {
    const data = getErrorData(error);
    if (typeof data === 'string') return data;
    if (isRecord(data)) return getStringProperty(data, 'message');
    return undefined;
}

export function getErrorDataString(error: unknown): string | undefined {
    const data = getErrorData(error);
    return typeof data === 'string' ? data : undefined;
}
