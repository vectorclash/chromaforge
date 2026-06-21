import React from 'react';
import { useAuth } from '../context/AuthContext';

// Placeholder -- real sign-in/up + account view lands in the flow-porting phase. Reads
// useAuth so the provider wiring is verifiable now.
export default function AccountPage() {
  const { user } = useAuth();
  return (
    <div>
      <h1 className="font-quicksand text-3xl font-bold">Account</h1>
      <p className="mt-2 text-neutral-500">
        {user ? `Signed in as ${user.email}` : 'Not signed in.'}
      </p>
    </div>
  );
}
