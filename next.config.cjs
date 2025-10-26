/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',        // ✅ enables static export
  distDir: 'out',          // ✅ tells Next.js to export into ./out
  images: {
    unoptimized: true,     // ✅ allows images in static export
  },
};

module.exports = nextConfig;
