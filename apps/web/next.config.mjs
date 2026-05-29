/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@emberforge/core'],
  async rewrites() {
    const api = process.env.EMBERFORGE_API_URL ?? 'http://localhost:8080';
    return [{ source: '/api/ef/:path*', destination: `${api}/:path*` }];
  },
};
export default nextConfig;
