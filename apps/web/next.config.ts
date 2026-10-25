import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: [
    '@memoria/contracts',
    '@memoria/block-catalog',
    '@memoria/blocks-core',
    '@memoria/blocks-ui',
    '@memoria/block-standard',
    '@memoria/block-character-card',
  ],
  poweredByHeader: false,
  allowedDevOrigins: ['localhost'],
  async headers() {
    return [
      {
        source: '/recuperation',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};
export default config;
