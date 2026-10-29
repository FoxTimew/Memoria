export function imageId(): string;
export function imageFixture(large?: boolean): Promise<string>;
export function decodeFixture(
  path: string,
): Promise<{ status: string; preview: string; variants: unknown[] }>;
