/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // ✅ hybrid mode for apps with APIs
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
