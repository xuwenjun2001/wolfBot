const enableHsts = /^(?:1|true|yes|on)$/i.test(
  process.env.WOLF_RESEARCH_SECURITY_HSTS || '',
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  serverExternalPackages: ['@prisma/client', 'prisma'],
  experimental: {
    optimizeCss: false,
    scrollRestoration: true,
  },
  turbopack: {},
  async headers() {
    const securityHeaders = [
      {
        key: 'Content-Security-Policy',
        value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      ...(enableHsts
        ? [
            {
              key: 'Strict-Transport-Security',
              value: 'max-age=31536000; includeSubDomains',
            },
          ]
        : []),
    ];
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
