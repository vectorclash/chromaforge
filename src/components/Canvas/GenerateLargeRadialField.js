import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';
import { getCountScale, getSizeScale } from '../../render/scale';

export default class GenerateLargeRadialField {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};

    config.width = width;
    config.height = height;

    // Sized off the smaller dimension, same reasoning as GenerateStarField -- see
    // render/scale.js.
    config.radGradSize = getSizeScale(width, height) / 2;

    // `amount` (the loop trip count) is computed unscaled -- exactly one rng() draw,
    // matching pre-fix behavior -- and the loop always runs the full unscaled amount, so
    // total rng() consumption here never depends on canvas size (each iteration below
    // consumes a variable number of draws depending on color branches, so varying the trip
    // count itself would desync every rng() draw downstream of this class -- same reasoning
    // as GenerateStarField's fixed-generate-then-truncate pattern). Only the KEPT subset
    // (pushed into config.radGradients below) is size-scaled.
    let amount = 2 + Math.round(rng() * 8);
    let keepAmount = Math.max(1, Math.round(amount * getCountScale(width, height)));
    let radGradients = [];

    for (let i = 0; i < amount; i++) {
      let radGrad = {};
      radGrad.alpha = rng().toFixed(2);
      radGrad.size = Math.round(config.radGradSize / 2 + rng() * config.radGradSize * 4);
      radGrad.x = Math.round(-radGrad.size + rng() * width + radGrad.size / 2);
      radGrad.y = Math.round(-radGrad.size + rng() * height + radGrad.size / 2);
      radGrad.colors = [];

      let colorAmount = 2 + Math.round(rng() * 3);

      if (colors.length > 0) {
        if (colors.length === 1) {
          let colorChance = rng();
          if (colorChance > 0.5) {
            let ranGrayScale = Math.round(rng() * 255);
            let newColor = tinycolor({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale });
            let colorOrderChance = rng();
            if (colorOrderChance > 0.5) {
              radGrad.colors.push(colors[0]);
              radGrad.colors.push(newColor);
            } else {
              radGrad.colors.push(newColor);
              radGrad.colors.push(colors[0]);
            }
          }
        } else {
          radGrad.colors = colors.slice();
        }
      } else {
        let gradientType = rng();

        if (gradientType > 0.5) {
          let colorStart = rng() * 360;
          let colorDistance = rng() * 50;
          for (let i = 0; i < colorAmount; i++) {
            radGrad.colors.push(
              tinycolor('#CCFF00')
                .spin(colorStart + colorDistance * i)
                .toHexString()
            );
          }
        } else {
          let colorType = rng();

          for (let i = 0; i < colorAmount; i++) {
            if (colorType > 0.8) {
              radGrad.colors.push(randomColorHex(rng));
            } else {
              radGrad.colors.push(
                tinycolor('#CCFF00')
                  .spin(Math.round(rng() * 360))
                  .toHexString()
              );
            }
          }
        }
      }

      radGradients.push(radGrad);
    }

    config.radGradients = radGradients.slice(0, keepAmount);

    return config;
  }
}
