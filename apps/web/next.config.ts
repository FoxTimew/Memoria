import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@memoria/contracts'],
  poweredByHeader: false,
  allowedDevOrigins: ['localhost'],
};
export default config;
