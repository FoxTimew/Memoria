/** Docker's Windows terminal renderer wraps each JSON line in ANSI erase sequences. */
export function parseContainerStats(line) {
  const start = line.indexOf('{'),
    end = line.lastIndexOf('}');
  if (start < 0) return undefined;
  const value = JSON.parse(line.slice(start, end + 1));
  if (
    !/^\d+(?:\.\d+)?%$/.test(value.CPUPerc) ||
    typeof value.MemUsage !== 'string' ||
    typeof value.BlockIO !== 'string'
  )
    throw new Error('INVALID_CONTAINER_STATS');
  return { cpu: value.CPUPerc, memory: value.MemUsage, io: value.BlockIO };
}
