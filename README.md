# ChromaForge

A generative art application that creates stunning, unique space-themed vector graphics using HTML5 Canvas and procedural generation techniques.

## What is ChromaForge?

ChromaForge is an interactive web application that generates beautiful, abstract space-themed images by combining procedurally generated elements including:

- **Linear & Radial Gradients** - Dynamic color blending with customizable palettes
- **Star Fields** - Thousands of procedurally placed stars in varying sizes
- **Geometric Shapes** - Randomly generated triangular patterns with gradient fills
- **Blend Modes** - Advanced composite operations for unique visual effects
- **Color Theming** - User-defined color palettes that influence all generated elements

Each generated image is unique, created using randomized parameters, blend modes, and compositions. No two images are ever the same.

## Features

### Generation & Customization
- **One-Click Generation** - Press Enter or click "Generate" to create a new image
- **Custom Color Palettes** - Add, remove, and customize colors using an integrated color picker
- **Randomized Compositions** - Each generation uses random:
  - Gradient directions and complexities
  - Star counts and distributions (ranging from hundreds to 100,000+ stars)
  - Geometric shape counts and arrangements
  - Blend modes (overlay, hard-light, destination-atop, etc.)
  - Opacity levels for layered effects

### Save & Share
- **URL-Based Sharing** - Every generated image can be saved and shared via a unique URL
- **Automatic Compression** - Small configurations are encoded directly in URLs
- **LocalStorage Fallback** - Large configurations automatically use localStorage with short IDs
- **Download as JPG** - Export your creations in high-quality JPEG format

### Technical Highlights
- Built with **React 18** and modern JavaScript (ES6+)
- Canvas rendering with **HTML5 Canvas API** and **CreateJS**
- Smooth animations powered by **GSAP 3**
- Responsive, engaging UI with hover effects and transitions
- Optimized for performance with efficient memory management

## Getting Started

### Prerequisites
- Node.js (v14 or higher recommended)
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/chromaforge.git

# Navigate to the project directory
cd chromaforge

# Install dependencies
npm install

# Start the development server
npm start
```

The application will open in your browser at [http://localhost:3000](http://localhost:3000).

## Available Scripts

### `npm start`
Runs the app in development mode with hot-reloading enabled.

### `npm run build`
Builds the app for production to the `build` folder. The build is minified and optimized for best performance.

### `npm test`
Launches the test runner in interactive watch mode.

## How It Works

### Generation Pipeline

1. **Color Selection** - Users define a color palette (or use defaults)
2. **Configuration Building** - Random parameters are generated for each layer:
   - Background gradient (always present)
   - Optional radial field overlay (60% chance)
   - Star field with gradient overlay (always present)
   - Optional geometric shapes (40% chance)
   - Optional gradient overlay (30% chance if colors exist)

3. **Canvas Rendering** - Each layer is rendered to its own canvas:
   - `LinearGradient` - Creates linear gradients with configurable directions
   - `RadialGradient` - Creates radial gradients fading to transparent
   - `StarField` - Draws thousands of stars with a gradient overlay
   - `LargeRadialField` - Renders multiple overlapping radial gradients
   - `GeometricShape` - Draws triangular shapes with CreateJS

4. **Composition** - Layers are composited using various blend modes:
   - `overlay` - Combines highlights and shadows
   - `hard-light` - Intensifies colors
   - `destination-atop` - Clips to existing content
   - And more...

5. **Export** - Final canvas is converted to a blob and displayed

### URL Configuration System

When you save an image, ChromaForge:
1. Serializes the entire configuration to JSON
2. Encodes it to base64 and makes it URL-safe
3. Checks the URL length:
   - **Short URLs (<2000 chars)**: Embeds config directly in URL as `?config=...`
   - **Long URLs (>2000 chars)**: Stores config in localStorage with a short ID like `?id=abc123`
4. Provides a shareable link that anyone can use to recreate the exact same image

## Technology Stack

### Core
- **React 18.3** - Modern component-based UI
- **HTML5 Canvas** - High-performance 2D rendering
- **CreateJS** - Shape rendering and manipulation

### Animations & Effects
- **GSAP 3.13** - Professional-grade animations
- **CSS Transitions** - Smooth UI interactions

### Utilities
- **TinyColor2** - Color manipulation and analysis
- **FileSaver.js** - Client-side file downloads
- **Iro Color Picker** - Interactive color selection

### Styling
- **Sass** - Enhanced CSS with variables and nesting
- **Custom CSS** - Gradient effects and blend modes

## Project Structure

```
chromaforge/
├── public/              # Static assets
├── src/
│   ├── assets/         # Images (star sprites)
│   ├── components/     # React components
│   │   ├── Canvas/     # Canvas rendering functions
│   │   │   ├── LinearGradient.js
│   │   │   ├── RadialGradient.js
│   │   │   ├── StarField.js
│   │   │   ├── LargeRadialField.js
│   │   │   ├── GeometricShape.js
│   │   │   ├── Generate*.js  # Config generators
│   │   ├── buttons/    # UI buttons
│   │   ├── DisplayCanvas.js  # Main component
│   │   ├── ColorField.js
│   │   ├── HexagonLoader.js
│   │   └── Copyright.js
│   ├── utils/          # Utility functions
│   │   └── urlConfig.js  # URL encoding/decoding
│   ├── App.js
│   └── index.js
└── package.json
```

## Browser Support

ChromaForge works in all modern browsers that support:
- HTML5 Canvas API
- ES6+ JavaScript
- CSS3 Transitions and Animations
- LocalStorage API

Tested and working on:
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Performance Considerations

- **Memory Management**: Canvases are cleared after compositing to free memory
- **Star Count Optimization**: Small stars are rendered with size-based culling
- **Efficient Rendering**: Each layer uses its own canvas to avoid redraws
- **Blob URLs**: Object URLs are created only when needed

## Future Enhancements

Potential features for future releases:
- SVG export option
- Animation/video generation
- Preset gallery
- Advanced blend mode controls
- Multi-image batch generation
- Custom resolution settings
- Undo/redo functionality

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is open source and available under the MIT License.

## Acknowledgments

- Built with Create React App
- Color theory and gradients inspired by cosmic nebulae and space photography
- Special thanks to the open-source community for the amazing libraries used in this project

---

Made with ❤️ and canvas rendering
