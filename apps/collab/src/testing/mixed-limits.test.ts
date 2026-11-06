import { expect, it } from 'vitest';
import { assessMixedPage, developmentWaiver } from './mixed-limits.ts';

it('only waives typical-server latency in the authorized development history/8K case', () => {
  const page = { index: 2, encodedBytes: 180000, p95: { server: 55.624, wire: 112 } };
  const context = { platform: 'win32', waiver: developmentWaiver, isolated: false };
  expect(assessMixedPage('history-1M', true, page, context)).toMatchObject({
    serverPassed: true,
    serverExceeded: true,
    waived: true,
    wirePassed: true,
  });
  for (const [profile, conversions, p, c] of [
    ['content-1M', true, page, context],
    ['history-1M', false, page, context],
    ['history-1M', true, page, { ...context, waiver: undefined }],
    ['history-1M', true, page, { ...context, waiver: 'invalid' }],
    ['history-1M', true, page, { ...context, platform: 'linux' }],
    ['history-1M', true, page, { ...context, isolated: true }],
    ['history-1M', true, { ...page, encodedBytes: 200 * 1024 + 1 }, context],
    ['history-1M', true, { ...page, p95: { ...page.p95, server: Infinity } }, context],
    ['history-1M', true, { ...page, index: 0, p95: { server: 101, wire: 350 } }, context],
  ] as const) {
    expect(assessMixedPage(profile, conversions, p, c)).toMatchObject({
      serverPassed: false,
      waived: false,
    });
  }
  expect(
    assessMixedPage('history-1M', true, { ...page, p95: { server: 55, wire: 201 } }, context),
  ).toMatchObject({ waived: true, wirePassed: false });
  expect(
    assessMixedPage('history-1M', true, { ...page, p95: { server: 49, wire: 150 } }, context),
  ).toMatchObject({ waived: false, serverPassed: true });
});
