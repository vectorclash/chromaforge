import React from 'react';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import { useAuth } from '../context/AuthContext';

// Placeholder using the new UI primitives so the design system is verifiable. The real
// sign-in/up logic (email/password + Google, sign out) wires up in the flow-porting phase.
export default function AccountPage() {
  const { user } = useAuth();

  if (user) {
    return (
      <PageContainer title="Account" subtitle={`Signed in as ${user.email}`}>
        <Button variant="secondary">Sign out</Button>
      </PageContainer>
    );
  }

  return (
    <PageContainer title="Sign in" subtitle="Save your designs and order prints.">
      <div className="max-w-sm space-y-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" placeholder="you@example.com" />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" placeholder="••••••••" />
        </Field>
        <Button className="w-full">Sign in</Button>
        <Button variant="secondary" className="w-full">Continue with Google</Button>
      </div>
    </PageContainer>
  );
}
