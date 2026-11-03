// Hosted mode (ADR 0013): Cozy Studio runs as a Neon Function behind a Vercel UI. Each instance
// keeps disposable storage folders under HOSTED_ROOT that mirror object storage, and every absolute
// path stored in Postgres resolves to the same place in every instance.
export const HOSTED_ROOT = '/tmp/cozy';

export function isHostedMode(env: NodeJS.ProcessEnv = process.env) {
  return env.STUDIO_HOSTED === '1';
}

export function applyHostedEnvironment(env: NodeJS.ProcessEnv = process.env) {
  env.STUDIO_HOSTED = '1';
  env.STUDIO_LIBRARY_DIR ??= `${HOSTED_ROOT}/Library`;
  env.STUDIO_IMAGES_DIR ??= `${HOSTED_ROOT}/Pictures`;
  env.STUDIO_EXTENSION_INSTALL_DIR ??= `${HOSTED_ROOT}/Extensions`;
  env.XDG_DATA_HOME ??= `${HOSTED_ROOT}/data`;
  env.XDG_STATE_HOME ??= `${HOSTED_ROOT}/state`;
  env.STUDIO_DATABASE_URL ??= env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  // ChatGPT is the hosted provider; one image at a time matches the local default.
  env.STUDIO_MAX_CONCURRENT_JOBS ??= '2';
}

export function requireHostedSetting(name: string, env: NodeJS.ProcessEnv = process.env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Hosted Cozy Studio needs ${name}.`);
  return value;
}
