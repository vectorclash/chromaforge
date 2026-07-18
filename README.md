# Chromaforge

**Live at [chromaforge.app](https://chromaforge.app).**

A generative art studio that turns procedural, space-themed compositions into
shareable designs, looping animations, and real printed merch. Generate a piece,
save it to your gallery, preview it on a product, and buy it — the print file that
goes to production is the same deterministic artwork you approved on screen.

## Features

### Studio
- **One-click generation** — layered gradients, star fields, radial fields, and
  geometric structures composited with randomized blend modes; every output is unique
- **Custom color palettes** — add, remove, reorder, or restore defaults
- **Geometry controls** — sliders for shape chance, point count, coherence (chaos →
  ordered chord-web lattice), and size
- **Share links** — a design is a tiny JSON config; anyone with the link re-renders
  the exact same artwork
- **4K JPEG download**

### Animation
- **2D mode** — multi-frame gradient crossfades with a star overlay, seamless loops
- **3D mode** — a real-time three.js flight through a geometric star tunnel built
  from the same design seed and palette
- **MP4 export** — fully client-side via WebCodecs + mp4-muxer (no server involved)

### Accounts & gallery
- Email/password and Google sign-in (Supabase Auth)
- Save designs, browse the public gallery, like designs, reload any saved design
  into the studio

### Merch
- Product mockups rendered from your actual design via Printful's mockup API
- Per-order options (geometry placement per print area, layout for two-leg garments)
- Stripe Checkout (cards, Apple Pay / Google Pay), automatic tax, region-based shipping
- Fulfillment through Printful, with order history and status tracking in your account

## How it works

The renderer is a pure deterministic function of `(seed, colors, settings, width,
height)`. A design is just `{ generatorVersion, seed, colors, settings }` — a few
hundred bytes — and every surface re-renders it fresh at its own resolution and
aspect ratio: studio canvas, gallery thumbnail, product mockup, and the actual
print file are sibling compositions from the same seed, not scaled copies of one
bitmap.

| Piece | What it does |
|---|---|
| `src/render/` | Seeded PRNG + pure generation/compositing (React-free) |
| `src/components/Canvas/` | Per-layer generators and renderers |
| `src/pages/`, `src/components/` | Vite + React 19 app, Tailwind v4 + GSAP UI |
| `src/animation3d/` | three.js tunnel scene (lazy-loaded chunk) |
| `supabase/` | Postgres schema/migrations, Auth config, Edge Functions (checkout, webhooks, mockups, rate limiting) |
| `render-service/` | Node + `@napi-rs/canvas` service on Fly.io that runs the *same* renderer bundle at print resolution (mobile browsers can't allocate print-size canvases) |
| `scripts/` | Printful catalog-drift check (daily GitHub Actions cron) |

Payments are Stripe Checkout; orders are submitted to Printful by a
signature-verified Stripe webhook. Deploys are GitHub Actions → rsync over SSH on
every push to `master`.

For the full architecture decisions and their reasoning, see [CLAUDE.md](CLAUDE.md)
(kept current as the project's living handoff doc). Operational/launch notes live
in [TODO.md](TODO.md).

## Getting started

```bash
git clone https://github.com/vectorclash/chromaforge.git
cd chromaforge
npm install
```

Create `.env.local` with the Supabase project credentials (ask the maintainer —
these aren't derivable from the repo):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Then `npm start` — opens at [http://localhost:5173](http://localhost:5173).
The studio and generation work without Supabase configured; accounts, gallery,
and shop need the env vars.

## Scripts

| Command | Description |
|---|---|
| `npm start` | Vite dev server (port 5173) |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build locally |
| `npm run format` | Prettier format |

## Browser support

MP4 export requires the **WebCodecs API** (Chrome/Edge 94+, Safari 16.4+; not
Firefox). The 3D animation mode requires WebGL and falls back to 2D where
unavailable. Everything else works in all modern browsers.

## Attribution

The homepage's 3D t-shirt preview uses the
["Tshirt" model](https://sketchfab.com/3d-models/tshirt-a88d6e25d67c4b0c91b9ea013e679870)
by [khalilchahi99](https://sketchfab.com/khalilchahi99), licensed
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
(`public/models/tshirt/license.txt`).
