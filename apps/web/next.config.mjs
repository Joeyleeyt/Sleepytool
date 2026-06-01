import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Load the monorepo-root `.env` into process.env BEFORE Next reads anything.
// The old apps/api ran with `node --env-file=../../.env`; Next.js only reads
// .env from its own project dir, so we have to do this ourselves.
//
// Implemented inline (no `dotenv` / `@next/env` dep) because both have edge
// cases where they silently fail in monorepo + dev-server scenarios. Reading
// the file directly gives us a single, visible log line confirming it worked.
// =============================================================================
{
  // Vercel + most managed CI inject env vars from a dashboard; there's no
  // root-level .env file in those build containers. Skip the local-file load
  // entirely so we don't spam a confusing "could NOT load .env" warning in
  // production builds.
  const onManagedCi = !!(
    process.env.VERCEL ||
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.NETLIFY ||
    process.env.RAILWAY_ENVIRONMENT
  );
  if (!onManagedCi) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(here, '../../.env');
    try {
      const content = readFileSync(envPath, 'utf8');
      let loaded = 0;
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // Don't override anything the parent shell already exported — same
        // precedence Node's --env-file uses.
        if (!(key in process.env)) {
          process.env[key] = value;
          loaded += 1;
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[next.config] loaded ${loaded} env var(s) from ${envPath}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[next.config] .env not found at ${envPath} — using process env only. (${err.message})`);
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-side packages we import from route handlers must be transpiled by
  // Next since they ship as TypeScript source from the monorepo.
  transpilePackages: [
    '@emberforge/core',
    '@emberforge/db',
    '@emberforge/queue',
    '@emberforge/storage',
    '@emberforge/ai-clients',
    '@emberforge/prompt-engine',
    '@emberforge/timeline-engine',
  ],
  // Keep heavy server-only deps out of the client bundle.
  experimental: {
    serverComponentsExternalPackages: ['postgres', 'ioredis', 'bullmq', '@aws-sdk/client-s3'],
  },
  // Workspace packages use NodeNext-style explicit-`.js` imports for their
  // own source files (e.g. `import { X } from '../enums.js'` where the actual
  // file on disk is `enums.ts`). `tsx` / Node ESM resolve this natively;
  // webpack 5 needs an extension alias to do the same swap.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js':  ['.ts',  '.tsx', '.js',  '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};
export default nextConfig;
