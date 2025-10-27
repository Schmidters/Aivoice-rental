/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  basePath: '/dashboard', // ✅ fixes all 404s
  images: { unoptimized: true },
};
module.exports = nextConfig;
