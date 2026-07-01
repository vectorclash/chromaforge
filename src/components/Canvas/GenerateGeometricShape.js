import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';
import { getSizeScale } from '../../render/scale';

export default class GenerateGeometricShape {
  constructor(width, height, shapeNum, colors = [], rng = Math.random) {
    let config = {
      width: width,
      height: height,
      shapes: []
    };

    this.rng = rng;
    this.colors = colors;

    this.shapeVertices = 3 + Math.round(rng() * 9);
    this.shapeDepth = 2 + Math.round(rng() * 4);
    this.shapeAng = 360 / this.shapeVertices;
    // Sized off the smaller dimension, not width alone (see render/scale.js) -- the "width *
    // height / (height * 3)" this replaces algebraically reduced to just "width / 3" anyway,
    // so this wasn't the area-based formula it looked like. The "150 +" floor is left as an
    // intentional absolute minimum (avoids degenerate near-zero shapes at tiny sizes), not
    // part of the aspect-ratio bug this fixes.
    this.shapeSize = 150 + Math.round((rng() * getSizeScale(width, height)) / 3);

    this.points = this.pointsArray(this.shapeSize);

    for (let i = 0; i < shapeNum; i++) {
      config.shapes.push(this.buildShape());
    }

    return config;
  }

  pointsArray(r) {
    let radius = r;
    let points = [];

    points.push([0, 0]);

    for (let h = 1; h <= this.shapeDepth; h++) {
      for (let ang = 0; ang < 360; ang += this.shapeAng) {
        let rad = (ang * Math.PI) / 180;
        let newX = 0 + radius * h * Math.cos(rad);
        let newY = 0 + radius * h * Math.sin(rad);

        points.push([Math.round(newX), Math.round(newY)]);
      }
    }

    return points;
  }

  buildShape() {
    let shape = {
      colors: [],
      points: []
    };

    let randomPoints = this.between(0, this.points.length - 1);

    shape.points.push(
      this.points[randomPoints[0]],
      this.points[randomPoints[1]],
      this.points[randomPoints[2]]
    );

    if (this.colors.length > 0) {
      this.shuffleColors(this.colors);
      if (this.colors.length === 1) {
        let ranGrayScale = Math.round(this.rng() * 255);
        shape.colors.push(
          this.colors[0],
          tinycolor({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale }),
          tinycolor(this.colors[0])
            .spin(-40 + this.rng() * 80)
            .toHexString()
        );
      } else if (this.colors.length === 2) {
        shape.colors.push(
          this.colors[0],
          this.colors[1],
          tinycolor(this.colors[0])
            .spin(-20 + this.rng() * 40)
            .toHexString()
        );
      } else {
        shape.colors = this.colors;
      }
    } else {
      shape.colors.push(
        randomColorHex(this.rng),
        randomColorHex(this.rng),
        randomColorHex(this.rng)
      );
    }

    this.shuffle(shape.colors);

    return shape;
  }

  shuffleColors(array) {
    for (let i = 0; i < array.length; i++) {
      array[i] = tinycolor(array[i])
        .spin(-10 + this.rng() * 20)
        .toHexString();
    }
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      let j = Math.floor(this.rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  getRandomNumber(min, max) {
    let ranNumber = this.rng() * (max - min) + min;
    return ranNumber;
  }

  between(startNumber, endNumber) {
    let baseNumber = [];
    let randNumber = [];
    for (let i = startNumber; i <= endNumber; i++) {
      baseNumber[i] = i;
    }

    for (let i = endNumber; i > startNumber; i--) {
      let tempRandom = startNumber + Math.floor(this.rng() * (i - startNumber));
      randNumber[i] = baseNumber[tempRandom];
      baseNumber[tempRandom] = baseNumber[i];
    }

    randNumber[startNumber] = baseNumber[startNumber];

    return randNumber;
  }
}
