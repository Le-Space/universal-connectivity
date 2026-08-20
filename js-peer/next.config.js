/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // Relative asset paths, so the export also loads from a path-style IPFS
  // gateway (https://ipfs.aleph.im/ipfs/<cid>/). With the default absolute
  // '/_next/...' the browser asks the gateway root for the bundle and the app
  // never boots; only subdomain gateways happen to work.
  assetPrefix: './',
  reactStrictMode: true,
  productionBrowserSourceMaps: true,
  images: {
    unoptimized: true,
  },
}

module.exports = nextConfig
