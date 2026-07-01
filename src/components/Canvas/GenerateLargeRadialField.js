import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';
import { getCountScale, getSizeScale } from '../../render/scale';

export default class GenerateLargeRadialField {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};

    config.width = width;
    config.height = height;

    // Sized off the smaller dimension and counted off area, same reasoning as
    // GenerateStarField -- see render/scale.js.
    config.radGradSize = getSizeScale(width, height) / 2;
    config.radGradients = [];

    let amount = Math.max(1, Math.round((2 + rng() * 8) * getCountScale(width, height)));

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

      config.radGradients.push(radGrad);
    }

    return config;
  }
}
