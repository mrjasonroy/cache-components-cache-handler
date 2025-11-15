/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: "./data-cache-handler.mjs",
  },
};

export default nextConfig;
