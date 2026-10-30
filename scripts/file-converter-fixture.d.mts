export function converterImage(): string;
export function converterFixture(): Promise<{
  name: string;
  root: string;
  compose: string[];
  config: { directory: string; privateDirectory: string; budgetBytes: number };
  docker(args: string[]): string;
  close(): Promise<void>;
}>;
