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
};
export default config;
