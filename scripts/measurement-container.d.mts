export function parseContainerStats(
  line: string,
): { cpu: string; memory: string; io: string } | undefined;
