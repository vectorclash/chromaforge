// Alerts a human when an order needs attention post-payment -- originally just Printful
// submission failures in stripe-webhook (see the catch block there for why this isn't
// auto-refunded), now also used by printful-webhook for orders Printful itself later
// cancels/fails after submission. Shared so both functions report problems the same way
// instead of a human needing to know two different alert paths.
//
// Uses raw SMTP (npm:nodemailer) against the same Hostinger mailbox already configured for
// Supabase Auth emails -- that Auth SMTP config is Supabase's own system and isn't reachable
// from arbitrary Edge Functions, so this needs its own set of secrets even though it's the
// same underlying mailbox/credentials. Supabase's own docs recommend an HTTP email API
// (Resend) for sending mail *from* Edge Functions instead of raw SMTP, since serverless/edge
// runtimes commonly block outbound SMTP ports (25/465/587) -- deliberately trying raw SMTP
// here anyway since the mailbox is already set up; if this starts erroring with a connection
// failure in the logs, that's this exact restriction and the fix is switching to Resend.
//
// Needs these secrets: ORDER_ALERT_SMTP_HOST, ORDER_ALERT_SMTP_PORT, ORDER_ALERT_SMTP_USER,
// ORDER_ALERT_SMTP_PASSWORD (same values as the Hostinger mailbox/App Password used for
// Auth SMTP), ORDER_ALERT_EMAIL_TO (where the alert should land -- a real inbox a human
// checks, not the no-reply@ sending mailbox itself).
//
// Deliberately never throws -- a broken alert channel must not prevent the order itself
// from being correctly marked 'failed'/'canceled', or block the caller's webhook handler
// from returning its own "ok" response.
import nodemailer from "npm:nodemailer@^9";

export async function sendOrderFailureAlert(orderId: string, message: string) {
  const host = Deno.env.get("ORDER_ALERT_SMTP_HOST");
  const port = Deno.env.get("ORDER_ALERT_SMTP_PORT");
  const user = Deno.env.get("ORDER_ALERT_SMTP_USER");
  const pass = Deno.env.get("ORDER_ALERT_SMTP_PASSWORD");
  const to = Deno.env.get("ORDER_ALERT_EMAIL_TO");
  if (!host || !port || !user || !pass || !to) {
    console.error("order-alert: not sent -- ORDER_ALERT_* secrets not fully configured");
    return;
  }

  try {
    const transport = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465,
      auth: { user, pass }
    });
    await new Promise<void>((resolve, reject) => {
      transport.sendMail(
        {
          from: user,
          to,
          subject: `Chromaforge: order ${orderId} needs attention`,
          text:
            `A customer has already paid for order ${orderId}, but it now needs attention.\n\n` +
            `Details: ${message}\n\n` +
            `This customer is NOT auto-refunded -- check whether the order is fixable and ` +
            `resubmittable, or refund via the Stripe dashboard.`
        },
        err => (err ? reject(err) : resolve())
      );
    });
  } catch (err) {
    console.error("order-alert: failed to send alert email", err);
  }
}
