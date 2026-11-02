import { createSubscriptionAuthStore } from '../apps/local-server/src/auth/store';
import { getDb } from '../apps/local-server/src/db/connection';
import { migrateDb } from '../apps/local-server/src/db/migrations';
import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
} from '../apps/local-server/src/hosted/hostedAuth';
import { createSealedSubscriptionAuthStore } from '../apps/local-server/src/hosted/sealedCredentialStore';

// Owner tasks for hosted Cozy Studio (ADR 0012, docs/HOSTING.md). Needs STUDIO_DATABASE_URL, and
// STUDIO_SECRET_KEY for credential import, e.g.
//   STUDIO_DATABASE_URL="$(neon cs --pooled false)" bun --env-file=.env.hosted run hosted:admin token create laptop

const USAGE = `Usage:
  bun run hosted:admin token create <name>   Create an agent token (shown once)
  bun run hosted:admin token list            List active agent tokens
  bun run hosted:admin token revoke <id>     Revoke an agent token
  bun run hosted:admin import-chatgpt        Copy the local ChatGPT sign-in, sealed, to hosted`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!process.env.STUDIO_DATABASE_URL) fail('Set STUDIO_DATABASE_URL to the hosted Postgres URL.');
const [command, subcommand, ...rest] = process.argv.slice(2);
const database = getDb();
migrateDb(database);

if (command === 'token' && subcommand === 'create') {
  const { token, summary } = createAgentToken(database, rest.join(' ') || 'Agent');
  console.log(
    `Created agent token "${summary.name}" (${summary.id}). Copy it now; it is not shown again:\n${token}`,
  );
} else if (command === 'token' && subcommand === 'list') {
  for (const token of listAgentTokens(database)) {
    console.log(
      `${token.id}  ${token.name}  …${token.hint}  created ${token.createdAt}  last used ${token.lastUsedAt ?? 'never'}`,
    );
  }
} else if (command === 'token' && subcommand === 'revoke' && rest[0]) {
  console.log(revokeAgentToken(database, rest[0]) ? 'Revoked.' : 'No active token with that id.');
} else if (command === 'import-chatgpt') {
  const secret = process.env.STUDIO_SECRET_KEY ?? fail('Set STUDIO_SECRET_KEY (from .env.hosted).');
  const local = createSubscriptionAuthStore().readProvider('codex');
  if (local.status !== 'logged_in' || !local.refreshToken) {
    fail('No local ChatGPT sign-in found. Sign in through Settings in local Studio first.');
  }
  createSealedSubscriptionAuthStore({ database, secret }).writeProvider('codex', local);
  console.log(
    `Imported the ChatGPT sign-in for ${local.accountLabel ?? 'your account'} into hosted Studio.`,
  );
} else {
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
}

database.close();
