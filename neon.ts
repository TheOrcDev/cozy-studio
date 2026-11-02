import { defineConfig } from '@neon/config/v1';

// Hosted Cozy Studio on Neon (ADR 0012, docs/HOSTING.md). Deploy with:
//   neon deploy --env .env.hosted
// .env.hosted holds the secrets below and is never committed.
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env.hosted before deploying.`);
  return value;
};
const optional = (...names: string[]) =>
  Object.fromEntries(
    names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
  );

export default defineConfig({
  functions: {
    studio: {
      name: 'Cozy Studio',
      source: './apps/local-server/src/hosted/function.ts',
      // Native image codecs and the Postgres driver the synchronous bridge loads at run time.
      externalPackages: ['sharp', 'pg'],
      env: {
        STUDIO_OWNER_EMAIL: required('STUDIO_OWNER_EMAIL'),
        STUDIO_PUBLIC_ORIGIN: required('STUDIO_PUBLIC_ORIGIN'),
        STUDIO_SESSION_SECRET: required('STUDIO_SESSION_SECRET'),
        STUDIO_SECRET_KEY: required('STUDIO_SECRET_KEY'),
        STUDIO_SWEEP_SECRET: required('STUDIO_SWEEP_SECRET'),
        STUDIO_LIBRARY_BUCKET: 'studio-library',
        // Where Settings installs style packs from (docs/HOSTING.md). Unset means the public packs.
        ...optional(
          'STUDIO_EXTENSION_REMOTE_SOURCES',
          'STUDIO_GITHUB_API_BASE',
          'COZY_STYLES_GITHUB_TOKEN',
        ),
      },
    },
  },
  buckets: {
    'studio-library': { access: 'private' },
  },
  triggers: {
    // Adopts jobs whose instance was evicted and prunes old events. Every 15 minutes leaves the
    // Postgres compute room to scale to zero while nobody uses Studio.
    sweep: {
      type: 'schedule',
      function: 'studio',
      cron: '*/15 * * * *',
      functionPath: `/internal/sweep/${required('STUDIO_SWEEP_SECRET')}`,
    },
  },
});
