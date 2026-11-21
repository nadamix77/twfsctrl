import type { MetadataRoute } from 'next'

// The controller is a private operator panel — nothing should be
// crawled. Disallow everything, no sitemap (PRD-CONTROLLER §11).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/',
      },
    ],
  }
}
