import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';

// Hosted Cozy Studio sign-in (ADR 0012). Neon Auth sends a one-time code by email; its JWT is then
// exchanged for the Studio session cookie. Neon Auth is reached through the /neon-auth rewrite so
// its cookies stay first-party. Loaded only in hosted builds.

const AUTH_BASE = '/neon-auth';

async function postJson(path: string, body: unknown, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    ...init,
    headers,
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return data;
}

async function exchangeNeonAuthSession() {
  const response = await fetch(`${AUTH_BASE}/token`, { credentials: 'include' });
  const data = (await response.json().catch(() => ({}))) as { token?: string };
  if (!response.ok || !data.token) throw new Error('Could not read the Neon Auth session.');
  await postJson('/api/session', {}, { headers: { Authorization: `Bearer ${data.token}` } });
}

export async function readHostedSession() {
  const response = await fetch('/api/session', { credentials: 'include' });
  if (!response.ok) return false;
  const data = (await response.json()) as { authenticated?: boolean };
  return data.authenticated === true;
}

export async function signOutHostedSession() {
  await fetch('/api/session', { method: 'DELETE', credentials: 'include' });
  await fetch(`${AUTH_BASE}/sign-out`, { method: 'POST', credentials: 'include' }).catch(
    () => null,
  );
  window.location.reload();
}

function HostedSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await postJson(`${AUTH_BASE}/email-otp/send-verification-otp`, {
        email: email.trim(),
        type: 'sign-in',
      });
      setStep('code');
    });
  };

  const verifyCode = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await postJson(`${AUTH_BASE}/sign-in/email-otp`, { email: email.trim(), otp: code.trim() });
      await exchangeNeonAuthSession();
      onSignedIn();
    });
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[color:var(--wb-bg)] p-6">
      <form
        className="studio-dialog w-full max-w-sm space-y-4 p-6"
        onSubmit={step === 'email' ? sendCode : verifyCode}
      >
        <div>
          <h1 className="text-sm font-semibold text-[color:var(--wb-ink)]">Cozy Studio</h1>
          <p className="mt-1 text-sm text-[color:var(--wb-muted)]">
            {step === 'email'
              ? 'Sign in with your email. We send you a one-time code.'
              : `Enter the code sent to ${email.trim()}.`}
          </p>
        </div>
        {step === 'email' ? (
          <input
            className="studio-well w-full"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        ) : (
          <input
            className="studio-well w-full tracking-widest"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        )}
        {error ? <p className="text-sm text-[color:var(--wb-danger,#c0392b)]">{error}</p> : null}
        <div className="flex items-center justify-between gap-3">
          {step === 'code' ? (
            <button
              type="button"
              className="text-sm text-[color:var(--wb-muted)] hover:text-[color:var(--wb-ink)]"
              onClick={() => {
                setStep('email');
                setCode('');
              }}
            >
              Use another email
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="studio-primary-control" disabled={busy}>
            {busy ? 'Working…' : step === 'email' ? 'Send code' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Resolves once the owner has a Studio session, showing the sign-in form until then. */
export async function ensureHostedSession(container: HTMLElement) {
  if (await readHostedSession()) return;
  await new Promise<void>((resolve) => {
    const root = ReactDOM.createRoot(container);
    root.render(
      <HostedSignIn
        onSignedIn={() => {
          root.unmount();
          resolve();
        }}
      />,
    );
  });
}
