# ChromaForge

A generative art application that creates space-themed gradient imagery and animations using HTML5 Canvas and procedural generation.

## What is ChromaForge?

ChromaForge generates abstract, cosmic images and looping animations by layering procedurally built elements — gradients, star fields, radial overlays, and geometric shapes — composited with randomised blend modes. Every output is unique.

## Features

### Image Mode
- **One-click generation** — press Enter or click Generate
- **Custom color palettes** — add, remove, drag to reorder, or restore the default palette with 🌈
- **Randomised compositions** — blend modes, layer presence, gradient directions, and star distributions are all randomised per generation
- **Save & share** — configurations are encoded into a shareable URL; anyone with the link can recreate the exact image
- **Download as JPG** — 4K (3840×2160) JPEG export

### Animation Mode
- **Multi-frame generation** — builds a configurable number of gradient frames, each unique
- **Star overlay layer** — a separate set of transparent PNG star frames cross-fades over the gradient frames using GSAP
- **Seamless looping** — frame count, cycle duration, and star frame count are all configurable; timing constants are derived to keep the loop gapless
- **Play / pause** — floating button in the top-left with an SVG morph transition
- **Export as MP4** — H.264 High Profile encoded via WebCodecs + mp4-muxer at 40 Mbps (desktop) / 15 Mbps (mobile), 24fps

### UI
- Animated hexagon loader during generation
- GSAP-powered SVG morph buttons (open/close, play/pause)
- Controls panel with blur/scale transition
- Mobile-aware: square canvas and reduced export resolution on iOS/Android

## Getting Started

### Prerequisites
- Node.js v14+
- npm

### Installation

```bash
git clone https://github.com/yourusername/chromaforge.git
cd chromaforge
npm install
npm start
```

Opens at [http://localhost:3000](http://localhost:3000).

## Scripts

| Command | Description |
|---|---|
| `npm start` | Development server with hot reload |
| `npm run build` | Production build |
| `npm test` | Run tests |
| `npm run format` | Prettier format |

## How It Works

### Generation Pipeline

1. **Color palette** — user-defined or random; drives all layer color generation
2. **Config building** — random parameters per layer:
   - Linear gradient background (always)
   - Large radial field overlay (60% chance)
   - Star field with gradient mask (always)
   - Geometric shapes (40% chance)
   - Gradient overlay (30% chance)
3. **Canvas rendering** — each layer is drawn to its own off-screen canvas then composited with a randomised blend mode
4. **Export** — composited canvas is converted to a JPEG blob and displayed (image mode) or stored as a blob URL (animation mode)

### Animation Timing

All timing is derived from two values — `frameCount` and `cycleDuration` — so the loop is always gapless regardless of settings:

```
spacing     = cycleDuration / frameCount
fade        = spacing × (5 / 3.5)
starCount   = configurable (default: frameCount / 2)
starSpacing = cycleDuration / starCount
starFade    = starSpacing × (8 / 7)
```

### URL Sharing

Configurations are serialised to JSON, base64-encoded, and embedded in the URL (`?config=...`). Large configs fall back to localStorage with a short ID (`?id=...`).

## Tech Stack

| Layer | Libraries |
|---|---|
| UI | React 18, GSAP 3.15 (MorphSVGPlugin, DrawSVGPlugin) |
| Rendering | HTML5 Canvas, CreateJS (preload + shape drawing) |
| MP4 export | WebCodecs API, mp4-muxer |
| Color | TinyColor2, jscolor |
| Styling | Sass (sass-embedded) |
| Utilities | FileSaver.js |

## Project Structure

```
src/
├── assets/images/         # Star sprite PNGs
├── components/
│   ├── Canvas/            # Layer renderers + config generators
│   │   ├── LinearGradient.js
│   │   ├── LargeRadialField.js
│   │   ├── StarField.js
│   │   ├── GeometricShape.js
│   │   └── Generate*.js
│   ├── buttons/           # CloseButton, PlayPauseButton, SettingsButton…
│   ├── AnimationPreview.js
│   ├── DisplayCanvas.js   # Main orchestrator
│   ├── HexagonLoader.js
│   └── ColorField.js
└── utils/
    └── urlConfig.js
```

## Browser Support

MP4 export requires the **WebCodecs API** — available in Chrome/Edge 94+ and Safari 16.4+. Not supported in Firefox or iOS browsers below Safari 16.4.

Everything else works in all modern browsers.

## License

MIT
