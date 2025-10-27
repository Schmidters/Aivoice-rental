/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // keeps API routes working on DO
  basePath: '/dashboard', // ✅ critical line
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
