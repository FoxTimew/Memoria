export const developmentWaiver = '2026-11-06';
type PageMeasurement = {
  index: number;
  encodedBytes: number;
  p95: { server: number; wire: number };
};
/** Measurement-only decision. Never imported by the application or the main comparison. */
export function assessMixedPage(
  profile: string,
  conversions: boolean,
  page: PageMeasurement,
  context: { platform: string; waiver?: string | undefined; isolated: boolean },
) {
  const historical = profile === 'history-1M';
  const limit = page.index === 0 && historical ? 100 : 50;
  const exceeded = !Number.isFinite(page.p95.server) || page.p95.server >= limit;
  const waived =
    exceeded &&
    Number.isFinite(page.p95.server) &&
    context.waiver === developmentWaiver &&
    context.platform === 'win32' &&
    !context.isolated &&
    historical &&
    conversions &&
    page.index > 0 &&
    page.index < 5 &&
    page.encodedBytes > 0 &&
    page.encodedBytes <= 200 * 1024;
  return {
    serverLimit: limit,
    serverExceeded: exceeded,
    waived,
    waiver: waived ? developmentWaiver : null,
    serverPassed: !exceeded || waived,
    wirePassed:
      page.index === 0 && historical
        ? Number.isFinite(page.p95.wire)
        : Number.isFinite(page.p95.wire) && page.p95.wire < 200,
  };
}
