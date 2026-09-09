import React from 'react';
import PageContainer from '../components/ui/PageContainer';
import LegalSection from '../components/ui/LegalSection';
import { usePageMeta } from '../hooks/usePageMeta';

export default function TermsPage() {
  usePageMeta({
    title: 'Terms of Service',
    description: "Chromaforge's terms of service, covering accounts, orders and payment, printed product appearance, and returns.",
    path: '/terms'
  });
  return (
    <PageContainer title="Terms of Service">
      <p className="text-xs text-text-muted">Last updated: June 30, 2026</p>

      {/* intro-skip AND intro-stagger: the cascade nests. This block opts out of being a
          single item in the page's own cascade (a dozen sections arriving as one slab was
          the thing being fixed) and becomes a container in its own right, so each
          LegalSection gets its own delay from the same nth-child rules -- no per-section
          index to hand-maintain as sections are added or reordered. See tailwind.css. */}
      <div className="intro-skip intro-stagger mt-8 space-y-8">
        <LegalSection title="Agreement to Terms">
          <p>
            Chromaforge (chromaforge.app) is operated by Aaron Ezra Sterczewski ("we," "us"). By
            creating an account, saving a design, or placing an order, you agree to these Terms.
            If you don't agree, please don't use the site.
          </p>
        </LegalSection>

        <LegalSection title="The Service">
          <p>
            Chromaforge is a generative art tool: you create artwork from an algorithmic
            generator, save designs to your account, browse a public gallery of designs shared
            by other users, and optionally order the artwork printed on apparel. Printing and
            shipping is fulfilled by a third-party partner, Printful, Inc. ("Printful") — we
            don't manufacture or ship anything ourselves.
          </p>
        </LegalSection>

        <LegalSection title="Accounts">
          <p>
            You can use most of the site without an account. Creating one (email/password or
            "Continue with Google") lets you save designs and place orders. You're responsible
            for keeping your login credentials secure and for anything that happens under your
            account.
          </p>
        </LegalSection>

        <LegalSection title="Your Designs">
          <p>
            Designs you generate are yours — you can save them privately, order them printed, or
            share them to the public gallery. Anything you mark as public is visible to any
            visitor of the site, not just other account holders. The Chromaforge generator
            software, site design, and branding remain our property; saving or sharing a design
            doesn't transfer any rights in the underlying software.
          </p>
          <p>
            We reserve the right to remove public gallery content that violates these Terms.
          </p>
        </LegalSection>

        <LegalSection title="Orders &amp; Payment">
          <p>
            Prices are shown at checkout and charged via Stripe; we don't store your card
            details ourselves. Once payment succeeds, your order is submitted to Printful for
            production — each item is made to order specifically for you, it isn't pulled from
            existing stock.
          </p>
        </LegalSection>

        <LegalSection title="Printed Product Appearance">
          <p>
            The mockup preview you approve before checkout is generated the same way the actual
            print file is, so it's a close representation — but it is <em>not a guarantee</em> of
            exact appearance. Physical prints can differ from your screen due to garment
            material and color, printing technique, monitor calibration, and normal
            manufacturing variance between individual items. Placing an order means you accept
            that some difference between the on-screen preview and the physical product is
            expected and not, by itself, a defect.
          </p>
        </LegalSection>

        <LegalSection title="Returns, Refunds &amp; Replacements">
          <p>
            Because every item is custom-printed for your order, we can't accept returns for
            "change of mind," and color/print variance as described above is not eligible for a
            refund on its own. We will replace or refund an order that arrives with a genuine
            production defect (misprint, damaged item, or the wrong product/size shipped) —
            contact us within 14 days of delivery with photos of the issue and we'll make it
            right.
          </p>
          <p>
            Once an order has been submitted to production it generally can't be canceled or
            modified. If you spot a mistake in your order, contact us as soon as possible after
            checkout — we can't promise production hasn't already started, but we'll try.
          </p>
        </LegalSection>

        <LegalSection title="Prohibited Uses">
          <p>
            Don't use Chromaforge to generate, save, or share content that's illegal, infringes
            someone else's rights, or is intended to harass or deceive others. Don't attempt to
            disrupt the service (e.g. abusing the render pipeline, scraping at scale, or trying
            to bypass account/order limits).
          </p>
        </LegalSection>

        <LegalSection title="Third-Party Services">
          <p>
            Chromaforge relies on Supabase (accounts, data storage), Stripe (payment
            processing), Printful (printing and shipping), and optionally Google (sign-in). Your
            use of those features is also subject to those providers' own terms — we aren't
            responsible for their acts or omissions, including shipping delays or carrier
            issues once an order leaves Printful.
          </p>
        </LegalSection>

        <LegalSection title="Disclaimer &amp; Limitation of Liability">
          <p>
            The service is provided "as is," without warranties of any kind. To the maximum
            extent permitted by law, we aren't liable for indirect, incidental, or consequential
            damages arising from your use of the site or a product ordered through it, and our
            total liability for any claim is limited to the amount you paid for the order in
            question.
          </p>
        </LegalSection>

        <LegalSection title="Changes to These Terms">
          <p>
            We may update these Terms as the service changes. Continuing to use Chromaforge
            after an update means you accept the revised Terms.
          </p>
        </LegalSection>

        <LegalSection title="Governing Law">
          <p>These Terms are governed by the laws of the State of California, USA.</p>
        </LegalSection>

        <LegalSection title="Contact">
          <p>
            Questions about these Terms, or an order issue? Reach us at{' '}
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
