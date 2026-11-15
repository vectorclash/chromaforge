-- Two more visit events (2026-11-14): the first ad visitors recorded a page view and nothing
-- else, which cannot tell "looked at the hero and gave up" from "left before it appeared".
--   hero_shown  the homepage's first artwork appeared (props.ms: since the page started loading)
--   leave       the visitor left or switched away (props.seconds: since the page started loading)
alter table public.events drop constraint events_name_check;
alter table public.events add constraint events_name_check check (name in (
  'page_view',
  'home_section',
  'generate',
  'save_click',
  'shop_click',
  'scroll_cue_click',
  'product_view',
  'mockup_click',
  'mockup_ready',
  'mockup_failed',
  'buy_click',
  'checkout_redirect',
  'signup_submit',
  'signin_submit',
  'google_click',
  'hero_shown',
  'leave'
));
