import React, { useState } from 'react';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import { isSupabaseConfigured } from '../lib/supabase';
import { signInWithEmail, signUpWithEmail, signInWithGoogle, signOut } from '../lib/auth';
import { useAuth } from '../context/AuthContext';

export default function AccountPage() {
  const { user } = useAuth();
  const [mode, setMode] = useState('signin'); // signin | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  if (!isSupabaseConfigured) {
    return (
      <PageContainer title="Account" subtitle="Accounts are not configured in this environment.">
        <p className="text-neutral-500">Set Supabase credentials to enable sign-in.</p>
      </PageContainer>
    );
  }

  if (user) {
    return (
      <PageContainer title="Account" subtitle={`Signed in as ${user.email}`}>
        <Button
          variant="secondary"
          onClick={async () => {
            setBusy(true);
            try {
              await signOut();
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
        >
          Sign out
        </Button>
      </PageContainer>
    );
  }

  const onSubmit = async e => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (mode === 'signup') {
        const { needsConfirmation } = await signUpWithEmail(email, password);
        if (needsConfirmation) {
          setMessage('Check your email to confirm your account, then sign in.');
        }
      } else {
        await signInWithEmail(email, password);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer
      title={mode === 'signup' ? 'Create account' : 'Sign in'}
      subtitle="Save your designs and order prints."
    >
      <form onSubmit={onSubmit} className="max-w-sm space-y-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
        </Field>

        {error && <p className="text-sm text-accent">{error}</p>}
        {message && <p className="text-sm text-neutral-600">{message}</p>}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={signInWithGoogle}
          disabled={busy}
        >
          Continue with Google
        </Button>
      </form>

      <p className="mt-6 text-sm text-neutral-500">
        {mode === 'signup' ? 'Already have an account?' : 'New here?'}{' '}
        <button
          type="button"
          className="text-accent underline"
          onClick={() => {
            setMode(mode === 'signup' ? 'signin' : 'signup');
            setError(null);
            setMessage(null);
          }}
        >
          {mode === 'signup' ? 'Sign in' : 'Create one'}
        </button>
      </p>
    </PageContainer>
  );
}
