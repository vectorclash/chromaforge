import React from 'react';
import { Link } from 'react-router-dom';
import PageContainer from '../components/ui/PageContainer';
import LegalSection from '../components/ui/LegalSection';
import { usePageMeta } from '../hooks/usePageMeta';

const SUPPORT = (
  <a className="text-interactive hover:underline" href="mailto:support@chromaforge.app">
    support@chromaforge.app
  </a>
);

export default function TermsPage() {
  usePageMeta({
    title: 'Terms of Service',
    description:
      "Chromaforge's terms of service, covering accounts, public designs, orders and payment, printed product appearance, and returns.",
    path: '/terms'
  });
  return (
    <PageContainer title="Terms of Service">
      <p className="text-xs text-text-muted">Last updated: October 10, 2026</p>

      {/* intro-skip AND intro-stagger: the cascade nests. This block opts out of being a
          single item in the page's own cascade (a dozen sections arriving as one slab was
          the thing being fixed) and becomes a container in its own right, so each
          LegalSection gets its own delay from the same nth-child rules -- no per-section
          index to hand-maintain as sections are added or reordered. See tailwind.css. */}
      <div className="intro-skip intro-stagger mt-8 space-y-8">
        <LegalSection title="Agreement to Terms">
          <p>
            Chromaforge (chromaforge.app) is operated by Aaron Ezra Sterczewski ("we," "us"). By
            using the site, creating an account, saving a design, or placing an order, you agree
            to these Terms and to our{' '}
            <Link className="text-interactive hover:underline" to="/privacy">
              Privacy Policy
            </Link>
            . If you don't agree, please don't use the site.
          </p>
          <p>
            You must be at least 13 to create an account. To place an order you must be an adult
            where you live, or have a parent or guardian's permission.
          </p>
        </LegalSection>

        <LegalSection title="The Service">
          <p>
            Chromaforge is a generative art tool: you create still images and animations from an
            algorithmic generator, download them, save designs to your account, browse a public
            gallery of designs saved by other users, and optionally order artwork printed on
            apparel and other products. Printing and shipping are fulfilled by a third-party
            partner, Printful, Inc. ("Printful") — we don't manufacture or ship anything
            ourselves.
          </p>
        </LegalSection>

        <LegalSection title="Accounts">
          <p>
            You can use most of the site without an account. Creating one (email/password or
            "Continue with Google") lets you save designs, generate product previews, and place
            orders. You're responsible for keeping your login secure and for anything that
            happens under your account.
          </p>
          <p>
            Your username and display name appear publicly next to the designs you save, so they
            must follow the Prohibited Uses section below. We may change or remove ones that
            don't.
          </p>
        </LegalSection>

        <LegalSection title="Saved Designs Are Public">
          <p>
            Every design you save to your account is published to the public gallery, along with
            its title, a thumbnail, your display name, and your avatar. Anyone visiting the site,
            signed in or not, can view a saved design, open it in the studio, download it, and
            order it printed on a product. There is currently no private save. You can delete a
            design from My Designs at any time, which removes it from the gallery — but we can't
            recall copies other people have already downloaded or products already ordered.
          </p>
        </LegalSection>

        <LegalSection title="Your Designs &amp; Downloads">
          <p>
            We don't claim ownership of the designs you make. You're free to use your designs,
            and the images and videos you download, for any purpose, including commercially.
          </p>
          <p>
            Designs are produced by software from a random seed, so we can't promise that a
            design is unique, or that it qualifies for copyright protection where you live.
            Other people may create, download, or print the same or similar designs, especially
            designs that have been saved to the public gallery.
          </p>
          <p>
            When you save a design, you give us a worldwide, non-exclusive, royalty-free license
            to store, render, display, and reproduce it in order to run Chromaforge: showing it in
            the gallery, letting other users open, download, and order prints of it, and featuring
            it when we promote Chromaforge (for example on social media). This license ends when
            you delete the design, except for uses that have already happened, such as orders
            already placed or posts already published.
          </p>
          <p>
            The Chromaforge generator software, site design, logo, and branding remain our
            property; making, saving, or downloading a design doesn't transfer any rights in
            them. We may remove gallery content that violates these Terms.
          </p>
        </LegalSection>

        <LegalSection title="Orders &amp; Payment">
          <p>
            Prices are in US dollars and are shown before you pay. Shipping is added at checkout,
            along with any sales tax we're required to collect. Payment is processed by Stripe;
            we never see or store your full card details. Once payment succeeds, your order is
            submitted to Printful for production. Each item is made to order for you, not pulled
            from existing stock.
          </p>
          <p>
            We ship to the countries listed at checkout. Please choose the shipping option that
            matches your delivery country; if it doesn't, we may contact you before your order is
            produced. Orders shipped across a border may be subject to import duties or taxes
            charged by your country's customs authority. Delivery times are estimates, not
            guarantees.
          </p>
          <p>
            We may decline or cancel an order, for example if a price was displayed in error, a
            product becomes unavailable, Printful can't produce it, or we suspect fraud. If we
            cancel an order you've paid for, you'll receive a full refund. We may also pause
            purchasing on the store at any time.
          </p>
        </LegalSection>

        <LegalSection title="Previews &amp; Printed Product Appearance">
          <p>
            The product preview you see before checkout is generated by Printful from the same
            artwork we send for printing, so it's a close representation — but it is{' '}
            <em>not a guarantee</em> of exact appearance. Physical prints can differ from your
            screen due to garment material and color, printing technique, seams and stitching,
            monitor calibration, and normal manufacturing variance between individual items.
            Other renderings on the site, such as the 3D shirt on the homepage, are illustrations
            and don't show any specific product exactly. Placing an order means you accept that
            some difference between the on-screen preview and the physical product is expected
            and not, by itself, a defect.
          </p>
          <p>Printed products may include a small Chromaforge brand label or mark.</p>
        </LegalSection>

        <LegalSection title="Returns, Refunds &amp; Replacements">
          <p>
            Because every item is custom-printed for your order, we can't accept returns for
            "change of mind," and color/print variance as described above is not eligible for a
            refund on its own. We will replace or refund an order that arrives with a genuine
            production defect (misprint, damaged item, or the wrong product/size shipped) —
            contact us within 14 days of delivery with photos of the issue and we'll make it
            right. If a package is lost or damaged in transit, contact us and we'll work with
            Printful and the carrier to resolve it.
          </p>
          <p>
            Once an order has been submitted to production it generally can't be canceled or
            modified. If you spot a mistake in your order, contact us as soon as possible after
            checkout — we can't promise production hasn't already started, but we'll try.
          </p>
          <p>
            Nothing in this section limits any rights you have under consumer protection law
            where you live that can't be waived by contract.
          </p>
        </LegalSection>

        <LegalSection title="Prohibited Uses">
          <p>
            Don't use Chromaforge to create, save, or share anything illegal, infringing,
            hateful, or intended to harass or deceive others. That includes design titles,
            usernames, and display names: no impersonating other people or brands. Don't attempt
            to disrupt the service — for example by abusing the rendering or preview systems,
            scraping at scale, automating sign-ups, or trying to get around account, order, or
            rate limits.
          </p>
        </LegalSection>

        <LegalSection title="Suspension &amp; Termination">
          <p>
            We may suspend or close an account that breaks these Terms, and remove its public
            designs. You can stop using Chromaforge at any time, and ask us to delete your account
            by emailing {SUPPORT}. Orders already placed are still fulfilled or refunded under
            these Terms.
          </p>
        </LegalSection>

        <LegalSection title="Third-Party Services">
          <p>
            Chromaforge relies on Supabase (accounts and data storage), Stripe (payment
            processing), Printful (product previews, printing, and shipping), Fly.io (print-file
            rendering), Hostinger (website hosting and email), Cloudflare (bot protection on our
            sign-in forms), and optionally Google (sign-in). Your use of those features is also
            subject to those providers' own terms, and we aren't responsible for their acts or
            omissions.
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
          <p>
            Some places don't allow these exclusions or limits. Nothing in these Terms excludes
            or limits liability that can't legally be excluded or limited, or any statutory rights
            you have as a consumer.
          </p>
        </LegalSection>

        <LegalSection title="Changes to These Terms">
          <p>
            We may update these Terms, or change or discontinue parts of the service, as
            Chromaforge evolves. We'll update the "Last updated" date above when we do.
            Continuing to use Chromaforge after an update means you accept the revised Terms;
            orders are governed by the Terms in place when you placed them.
          </p>
        </LegalSection>

        <LegalSection title="Governing Law">
          <p>
            These Terms are governed by the laws of the State of California, USA. If you're a
            consumer, this doesn't take away the protection of any mandatory laws of the country
            where you live.
          </p>
        </LegalSection>

        <LegalSection title="Contact">
          <p>Questions about these Terms, or an order issue? Reach us at {SUPPORT}.</p>
        </LegalSection>
      </div>
    </PageContainer>
  );
}
