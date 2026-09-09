import React from 'react';
import PageContainer from '../components/ui/PageContainer';
import LegalSection from '../components/ui/LegalSection';
import { usePageMeta } from '../hooks/usePageMeta';

export default function PrivacyPage() {
  usePageMeta({
    title: 'Privacy Policy',
    description: "Chromaforge's privacy policy: what account, design, and order data is collected and how it's used.",
    path: '/privacy'
  });
  return (
    <PageContainer title="Privacy Policy">
      <p className="text-xs text-text-muted">Last updated: June 30, 2026</p>

      {/* intro-skip AND intro-stagger: the cascade nests. This block opts out of being a
          single item in the page's own cascade (a dozen sections arriving as one slab was
          the thing being fixed) and becomes a container in its own right, so each
          LegalSection gets its own delay from the same nth-child rules -- no per-section
          index to hand-maintain as sections are added or reordered. See tailwind.css. */}
      <div className="intro-skip intro-stagger mt-8 space-y-8">
        <LegalSection title="Overview">
          <p>
            This page explains what information Chromaforge (chromaforge.app, operated by Aaron
            Ezra Sterczewski) collects, why, and who it's shared with. We collect only what's
            needed to run the site and fulfill orders — we don't use advertising trackers or
            sell your data.
          </p>
        </LegalSection>

        <LegalSection title="Information We Collect">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="text-text">Account info:</span> email address, and if you sign in
              with Google, the name/avatar Google provides.
            </li>
            <li>
              <span className="text-text">Your designs:</span> the seed/color/settings data
              needed to regenerate a saved design, plus a thumbnail image, if you save one to
              your account.
            </li>
            <li>
              <span className="text-text">Order info:</span> shipping address, order contents,
              and order status, if you place an order. Payment card details are collected and
              processed directly by Stripe — we never see or store your full card number.
            </li>
            <li>
              <span className="text-text">Session data:</span> a login session token stored in
              your browser's local storage, so you stay signed in between visits.
            </li>
          </ul>
          <p>We don't currently use analytics or advertising trackers on the site.</p>
        </LegalSection>

        <LegalSection title="How We Use This Information">
          <p>
            To run your account (sign-in, saving/loading designs, the gallery), to process and
            fulfill orders, to contact you about an order or account issue, and to meet legal
            obligations (e.g. tax records for completed sales).
          </p>
        </LegalSection>

        <LegalSection title="Who We Share It With">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="text-text">Supabase</span> — hosts our database, authentication,
              and file storage.
            </li>
            <li>
              <span className="text-text">Stripe</span> — processes payment for orders.
            </li>
            <li>
              <span className="text-text">Printful</span> — receives your shipping address and
              print files to manufacture and ship your order.
            </li>
            <li>
              <span className="text-text">Google</span> — only if you choose "Continue with
              Google" to sign in.
            </li>
          </ul>
          <p>We don't sell your personal information to anyone.</p>
        </LegalSection>

        <LegalSection title="Public Designs">
          <p>
            Designs you choose to share to the public gallery — including their thumbnail and
            like count — are visible to any visitor of the site, signed in or not. Keep this in
            mind before sharing a design publicly.
          </p>
        </LegalSection>

        <LegalSection title="Data Retention &amp; Deletion">
          <p>
            We keep your account and design data as long as your account exists. There's no
            self-serve "delete account" button yet — email{' '}
            <a className="text-interactive hover:underline" href="mailto:support@chromaforge.app">
              support@chromaforge.app
            </a>{' '}
            to request deletion of your account and associated data, and we'll process it
            manually.
          </p>
        </LegalSection>

        <LegalSection title="Children's Privacy">
          <p>
            Chromaforge isn't directed at children under 13, and we don't knowingly collect
            personal information from them.
          </p>
        </LegalSection>

        <LegalSection title="Your Rights">
          <p>
            You can ask us what personal information we have about you, ask us to correct it, or
            ask us to delete it, by emailing{' '}
            <a className="text-interactive hover:underline" href="mailto:support@chromaforge.app">
              support@chromaforge.app
            </a>
            .
          </p>
        </LegalSection>

        <LegalSection title="Security">
          <p>
            We rely on Supabase and Stripe's security infrastructure for authentication, data
            storage, and payment processing. No online service can guarantee perfect security,
            but we take reasonable steps to protect your information.
          </p>
        </LegalSection>

        <LegalSection title="Changes to This Policy">
          <p>
            If this policy changes materially, we'll update the "Last updated" date above.
          </p>
        </LegalSection>

        <LegalSection title="Contact">
          <p>
            Questions about this policy?{' '}
            <a className="text-interactive hover:underline" href="mailto:support@chromaforge.app">
              support@chromaforge.app
            </a>
            .
          </p>
        </LegalSection>
      </div>
    </PageContainer>
  );
}
