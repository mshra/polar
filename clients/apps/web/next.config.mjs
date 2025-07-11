import bundleAnalyzer from '@next/bundle-analyzer'
import createMDX from '@next/mdx'
import mdxMetadata from '@polar-sh/mdx'
import { withSentryConfig } from '@sentry/nextjs'
import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import rehypeMdxImportMedia from 'rehype-mdx-import-media'
import rehypeSlug from 'rehype-slug'
import remarkFlexibleToc from 'remark-flexible-toc'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import { bundledLanguages, createHighlighter } from 'shiki'
import { themeConfig, themesList, transformers } from './shiki.config.mjs'

const POLAR_AUTH_COOKIE_KEY =
  process.env.POLAR_AUTH_COOKIE_KEY || 'polar_session'
const ENVIRONMENT =
  process.env.VERCEL_ENV || process.env.NEXT_PUBLIC_VERCEL_ENV || 'development'
const CODESPACES = process.env.CODESPACES === 'true'

const defaultFrontendHostname = process.env.NEXT_PUBLIC_FRONTEND_BASE_URL
  ? new URL(process.env.NEXT_PUBLIC_FRONTEND_BASE_URL).hostname
  : 'polar.sh'

const redirectDocs = (source, destination, permanent = false) => {
  return [
    {
      source: `/docs${source}`,
      destination: `/docs${destination}`,
      permanent,
    },
    {
      source: '/tools/:path*',
      destination: '/developers/sdk/:path*',
      has: [
        {
          type: 'host',
          value: 'docs.polar.sh',
        },
      ],
      permanent,
    },
  ]
}

const S3_PUBLIC_IMAGES_BUCKET_ORIGIN = process.env
  .S3_PUBLIC_IMAGES_BUCKET_HOSTNAME
  ? `${process.env.S3_PUBLIC_IMAGES_BUCKET_PROTOCOL || 'https'}://${process.env.S3_PUBLIC_IMAGES_BUCKET_HOSTNAME}${process.env.S3_PUBLIC_IMAGES_BUCKET_PORT ? `:${process.env.S3_PUBLIC_IMAGES_BUCKET_PORT}` : ''}`
  : ''
const baseCSP = `
    default-src 'self';
    connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL} ${process.env.S3_UPLOAD_ORIGINS} https://api.stripe.com https://maps.googleapis.com;
    frame-src 'self' https://*.js.stripe.com https://js.stripe.com https://hooks.stripe.com;
    script-src 'self' 'unsafe-eval' 'unsafe-inline' https://*.js.stripe.com https://js.stripe.com https://maps.googleapis.com;
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data: https://www.gravatar.com https://avatars.githubusercontent.com ${S3_PUBLIC_IMAGES_BUCKET_ORIGIN};
    font-src 'self';
    object-src 'none';
    base-uri 'self';
    ${ENVIRONMENT !== 'development' ? 'upgrade-insecure-requests;' : ''}
`
const nonEmbeddedCSP = `
  ${baseCSP}
  form-action 'self' ${process.env.NEXT_PUBLIC_API_URL};
  frame-ancestors 'none';
`
const embeddedCSP = `
  ${baseCSP}
  form-action 'self' ${process.env.NEXT_PUBLIC_API_URL};
  frame-ancestors *;
`
// Don't add form-action to the OAuth2 authorize page, as it blocks the OAuth2 redirection
// 10-years old debate about whether to block redirects with form-action or not: https://github.com/w3c/webappsec-csp/issues/8
const oauth2CSP = `
  ${baseCSP}
  frame-ancestors 'none';
`

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  transpilePackages: ['shiki'],
  pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],

  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,

  // Since Codespaces run behind a proxy, we need to allow it for Server-Side Actions, like cache revalidation
  // See: https://github.com/vercel/next.js/issues/58019
  ...(CODESPACES
    ? {
        experimental: {
          serverActions: {
            allowedForwardedHosts: [
              `${process.env.CODESPACE_NAME}-8080.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`,
              'localhost:8080',
              '127.0.0.1:8080',
            ],
            allowedOrigins: [
              `${process.env.CODESPACE_NAME}-8080.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`,
              'localhost:8080',
              '127.0.0.1:8080',
            ],
          },
        },
      }
    : {}),

  images: {
    remotePatterns: [
      ...(process.env.S3_PUBLIC_IMAGES_BUCKET_HOSTNAME
        ? [
            {
              protocol: process.env.S3_PUBLIC_IMAGES_BUCKET_PROTOCOL || 'https',
              hostname: process.env.S3_PUBLIC_IMAGES_BUCKET_HOSTNAME,
              port: process.env.S3_PUBLIC_IMAGES_BUCKET_PORT || '',
              pathname: process.env.S3_PUBLIC_IMAGES_BUCKET_PATHNAME || '**',
            },
          ]
        : []),
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        port: '',
        pathname: '**',
      },
      {
        protocol: 'https',
        hostname: '7vk6rcnylug0u6hg.public.blob.vercel-storage.com',
        port: '',
        pathname: '**',
      },
    ],
  },

  async rewrites() {
    return {
      beforeFiles: [
        // PostHog Rewrite
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
        },

        // docs.polar.sh rewrite
        {
          // The rewrite happens before everything else, so we need to make sure
          // it doesn't match the _next and assets directories
          source: '/:path((?!_next|assets).*)',
          has: [
            {
              type: 'host',
              value: 'docs.polar.sh',
            },
          ],
          destination: '/docs/:path',
        },
      ],
    }
  },
  async redirects() {
    return [
      // dashboard.polar.sh redirections
      {
        source: '/',
        destination: '/login',
        has: [
          {
            type: 'host',
            value: 'dashboard.polar.sh',
          },
        ],
        permanent: false,
      },
      ...(ENVIRONMENT === 'production'
        ? [
            {
              source: '/:client_secret(polar_cl_.*)',
              destination:
                'https://api.polar.sh/v1/checkout-links/:client_secret/redirect',
              has: [
                {
                  type: 'host',
                  value: 'buy.polar.sh',
                },
              ],
              permanent: false,
            },
            {
              source: '/:id',
              destination: 'https://polar.sh/api/checkout?price=:id*',
              has: [
                {
                  type: 'host',
                  value: 'buy.polar.sh',
                },
              ],
              permanent: false,
            },
          ]
        : []),
      {
        source: '/:path*',
        destination: 'https://polar.sh/:path*',
        has: [
          {
            type: 'host',
            value: 'dashboard.polar.sh',
          },
        ],
        permanent: false,
      },

      // Feature pages
      {
        source: '/products',
        destination: 'https://docs.polar.sh/products',
        has: [
          {
            type: 'host',
            value: 'polar.sh',
          },
        ],
        permanent: true,
      },
      {
        source: '/issue-funding',
        destination: 'https://docs.polar.sh/issue-funding',
        has: [
          {
            type: 'host',
            value: 'polar.sh',
          },
        ],
        permanent: true,
      },
      {
        source: '/llms.txt',
        destination: 'https://docs.polar.sh/llms.txt',
        permanent: true,
        has: [
          {
            type: 'host',
            value: 'polar.sh',
          },
        ],
      },
      {
        source: '/llms-full.txt',
        destination: 'https://docs.polar.sh/llms-full.txt',
        permanent: true,
        has: [
          {
            type: 'host',
            value: 'polar.sh',
          },
        ],
      },
      {
        source: '/donations',
        destination: 'https://docs.polar.sh/donations',
        has: [
          {
            type: 'host',
            value: 'polar.sh',
          },
        ],
        permanent: true,
      },

      ...redirectDocs('/issue-funding/overview', '/issue-funding', true),
      ...redirectDocs('/guides/:path*', '/developers/guides/:path*', true),
      ...redirectDocs('/tools/:path*', '/developers/sdk/:path*', true),
      ...redirectDocs('/contribute', '/developers/open-source', true),
      ...redirectDocs('/sandbox', '/developers/sandbox', true),
      ...redirectDocs(
        '/api/webhooks/:path*',
        '/developers/webhooks/:path*',
        true,
      ),
      ...redirectDocs('/api/sdk/:path*', '/developers/sdk/:path*', true),

      // Redirect /docs/overview/:path to /docs/:path
      ...redirectDocs('/overview/:path*', '/:path*', true),
      ...redirectDocs('/subscriptions', '/products', true),
      ...redirectDocs('/support/faq', '/', true),

      // Redirect old FAQ to docs.polar.sh
      ...(ENVIRONMENT === 'production'
        ? [
            {
              source: '/faq',
              destination: 'https://docs.polar.sh/faq/overview',
              has: [
                {
                  type: 'host',
                  value: 'polar.sh',
                },
              ],
              permanent: true,
            },
            {
              source: '/faq/:path*',
              destination: 'https://docs.polar.sh/faq/:path*',
              has: [
                {
                  type: 'host',
                  value: 'polar.sh',
                },
              ],
              permanent: true,
            },
          ]
        : []),

      // Logged-in user redirections
      {
        source: '/',
        destination: '/start',
        has: [
          {
            type: 'cookie',
            key: POLAR_AUTH_COOKIE_KEY,
          },
          {
            type: 'host',
            value: defaultFrontendHostname,
          },
        ],
        permanent: false,
      },

      // Redirect /maintainer to polar.sh if on a different domain name
      {
        source: '/dashboard/:path*',
        destination: `https://${defaultFrontendHostname}/dashboard/:path*`,
        missing: [
          {
            type: 'host',
            value: defaultFrontendHostname,
          },
          {
            type: 'header',
            key: 'x-forwarded-host',
            value: defaultFrontendHostname,
          },
        ],
        permanent: false,
      },

      // Redirect /docs to docs.polar.sh
      ...(ENVIRONMENT === 'production'
        ? [
            {
              source: '/docs/:path*',
              destination: 'https://docs.polar.sh/:path*',
              permanent: false,
            },
          ]
        : []),

      {
        source: '/maintainer',
        destination: '/dashboard',
        permanent: true,
      },
      {
        source: '/maintainer/:path(.*)',
        destination: '/dashboard/:path(.*)',
        permanent: true,
      },
      {
        source: '/finance',
        destination: '/finance/income',
        permanent: false,
      },
      {
        source: '/dashboard/:organization/overview',
        destination: '/dashboard/:organization',
        permanent: true,
      },
      {
        source: '/dashboard/:organization/products/benefits',
        destination: '/dashboard/:organization/benefits',
        permanent: true,
      },
      {
        source: '/dashboard/:organization/products/overview',
        destination: '/dashboard/:organization/products',
        permanent: true,
      },
      {
        source: '/dashboard/:organization/issues',
        destination: '/dashboard/:organization/issues/overview',
        permanent: false,
      },
      {
        source: '/dashboard/:organization/promote/issues',
        destination: '/dashboard/:organization/issues/badge',
        permanent: false,
      },
      {
        source: '/dashboard/:organization/issues/promote',
        destination: '/dashboard/:organization/issues/badge',
        permanent: false,
      },
      {
        source: '/dashboard/:organization/finance',
        destination: '/dashboard/:organization/finance/income',
        permanent: false,
      },

      // Account Settings Redirects
      {
        source: '/settings',
        destination: '/dashboard/account/preferences',
        permanent: true,
      },

      // Access tokens redirect
      {
        source: '/settings/tokens',
        destination: '/account/developer',
        permanent: false,
      },

      // Old blog redirects
      {
        source: '/polarsource/posts',
        destination: '/blog',
        permanent: false,
      },
      {
        source: '/polarsource/posts/:path(.*)',
        destination: '/blog/:path*',
        permanent: false,
      },

      // Fallback blog redirect
      {
        source: '/:path*',
        destination: 'https://polar.sh/polarsource',
        has: [
          {
            type: 'host',
            value: 'blog.polar.sh',
          },
        ],
        permanent: false,
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/((?!checkout|oauth2).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: nonEmbeddedCSP.replace(/\n/g, ''),
          },
          {
            key: 'Permissions-Policy',
            value:
              'payment=(), publickey-credentials-get=(), camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
        ],
      },
      {
        source: '/oauth2/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: oauth2CSP.replace(/\n/g, ''),
          },
          {
            key: 'Permissions-Policy',
            value:
              'payment=(), publickey-credentials-get=(), camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
        ],
      },
      {
        source: '/checkout/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: embeddedCSP.replace(/\n/g, ''),
          },
          {
            key: 'Permissions-Policy',
            value: `payment=*, publickey-credentials-get=*, camera=(), microphone=(), geolocation=()`,
          },
        ],
      },
    ]
  },
}

const createConfig = async () => {
  const highlighter = await createHighlighter({
    langs: Object.keys(bundledLanguages),
    themes: themesList,
  })
  const withMDX = createMDX({
    options: {
      remarkPlugins: [
        remarkFrontmatter,
        // Automatically turns frontmatter into NextJS Metadata
        // Also automatically generates an OpenGraph image URL
        mdxMetadata(`${process.env.NEXT_PUBLIC_FRONTEND_BASE_URL}/docs/og`),
        remarkGfm,
        remarkFlexibleToc,
        () => (tree, file) => ({
          ...tree,
          children: [
            // Wrap the main content of the MDX file in a BodyWrapper (div) component
            // so we might position the TOC on the right side of the content
            {
              type: 'mdxJsxFlowElement',
              name: 'BodyWrapper',
              attributes: [],
              children: tree.children,
            },
          ],
        }),
      ],
      rehypePlugins: [
        rehypeMdxImportMedia,
        rehypeSlug,
        [
          rehypeShikiFromHighlighter,
          highlighter,
          {
            themes: themeConfig,
            transformers,
          },
        ],
      ],
    },
  })

  let conf = withMDX(nextConfig)

  // Injected content via Sentry wizard below

  conf = withSentryConfig(conf, {
    // For all available options, see:
    // https://github.com/getsentry/sentry-webpack-plugin#options

    org: 'polar-sh',
    project: 'dashboard',

    // Pass the auth token
    authToken: process.env.SENTRY_AUTH_TOKEN,

    // Only print logs for uploading source maps in CI
    silent: !process.env.CI,

    // For all available options, see:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

    // Upload a larger set of source maps for prettier stack traces (increases build time)
    widenClientFileUpload: true,

    reactComponentAnnotation: {
      enabled: false,
    },

    // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
    // This can increase your server load as well as your hosting bill.
    // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
    // side errors will fail.
    tunnelRoute: '/monitoring',

    // Hides source maps from generated client bundles
    hideSourceMaps: true,

    // Automatically tree-shake Sentry logger statements to reduce bundle size
    disableLogger: true,

    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,
  })

  if (process.env.ANALYZE === 'true') {
    const withBundleAnalyzer = bundleAnalyzer({
      enabled: true,
    })
    conf = withBundleAnalyzer(conf)
  }

  return conf
}

export default createConfig
