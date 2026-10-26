// Product decision, 25 October 2026. Absolute ceilings are checked separately.
export function assessRegression(reference, candidate) {
  if (!Number.isFinite(reference) || reference <= 0 || !Number.isFinite(candidate) || candidate < 0)
    throw new Error('Invalid latency comparison');
  const changeMs = candidate - reference;
  const allowedRegressionMs = Math.max(reference * 0.1, 2);
  return {
    changeMs,
    changePercent: (changeMs / reference) * 100,
    allowedRegressionMs,
    exceedsRegression: changeMs > allowedRegressionMs,
  };
}
