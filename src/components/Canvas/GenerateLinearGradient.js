import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';

export default class GenerateLinearGradient {
  constructor(width, height, complexity = 0, colors = [], rng = Math.random) {
    let config = {};

    config.width = width;
    config.height = height;

    // set the gradient direction

    let ranDirection = rng();
    if (ranDirection > 0.5) {
      config.gradientDirection = {
        x1: 0,
        y1: Math.round(rng() * height),
        x2: width,
        y2: Math.round(rng() * height)
      };
    } else {
      config.gradientDirection = {
        x1: Math.round(rng() * width),
        y1: 0,
        x2: Math.round(rng() * width),
        y2: height
      };
    }

    // set the colors

    config.colors = [];

    if (colors.length > 0) {
      if (colors.length === 1) {
        let colorChance = rng();
        if (colorChance > 0.5) {
          let ranGrayScale = Math.round(rng() * 255);
          let newColor = tinycolor({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale });
          let colorOrderChance = rng();
          if (colorOrderChance > 0.5) {
            config.colors.push(colors[0]);
            config.colors.push(newColor);
          } else {
            config.colors.push(newColor);
            config.colors.push(colors[0]);
          }
        } else {
          let ranSpin = -20 + rng() * 40;
          let newColor = tinycolor(colors[0]).spin(ranSpin).toHexString();
          let colorOrderChance = rng();
          if (colorOrderChance > 0.5) {
            config.colors.push(colors[0]);
            config.colors.push(newColor);
          } else {
            config.colors.push(newColor);
            config.colors.push(colors[0]);
          }
        }
      } else {
        config.colors = colors;
      }
    } else {
      let colorAmount = 2 + complexity;

      let gradientType = rng();

      if (gradientType > 0.5) {
        let colorStart = rng() * 360;
        let colorDistance = rng() * 50;
        for (let i = 0; i < colorAmount; i++) {
          config.colors.push(
            tinycolor('#CCFF00')
              .spin(colorStart + colorDistance * i)
              .toHexString()
          );
        }
      } else {
        let colorType = rng();

        for (let i = 0; i < colorAmount; i++) {
          if (colorType > 0.8) {
            config.colors.push(randomColorHex(rng));
          } else {
            config.colors.push(
              tinycolor('#CCFF00')
                .spin(Math.round(rng() * 360))
                .toHexString()
            );
          }
        }
      }
    }

    return config;
  }
}
