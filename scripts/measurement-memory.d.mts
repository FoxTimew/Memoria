export type MemorySnapshot = {
  observedAt: string;
  windowsFreeBytes: number;
  power: { allowed: boolean; [key: string]: unknown };
  wsl: { bootId: string; memAvailableBytes: number; swapInPages: number; swapOutPages: number };
};
export type Preparation = { path: string; observation: MemorySnapshot };
export type Hygiene = {
  path: string;
  attempts: { path: string; status: string; reason: string | null }[];
  before: MemorySnapshot;
  after: MemorySnapshot;
  assessment: {
    valid: boolean;
    reason: string | null;
    intervals: number;
    deltaInPages: number;
    deltaOutPages: number;
  };
};
export function prepareMeasurement(label: string): Promise<Preparation>;
export function readMemorySnapshot(): MemorySnapshot;
export function assertMemoryStage(
  observation: MemorySnapshot,
  stage: 'before-preparation' | 'after-preparation',
): void;
export function runMeasuredSeries<T>(
  label: string,
  work: () => Promise<T>,
  options?: { preparation?: Preparation; maxAttempts?: number },
): Promise<{ result: T; hygiene: Hygiene }>;
