/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export', // ✅ enables static export instead of next export
  images: {
    unoptimized: true, // ✅ required for static export
  },
};

module.exports = nextConfig;
