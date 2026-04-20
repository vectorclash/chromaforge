import React from 'react';
import { gsap, Bounce, MorphSVGPlugin } from 'gsap/all';

import './CloseButton.scss';

export default class CloseButton extends React.Component {
  componentDidMount() {
    gsap.registerPlugin(MorphSVGPlugin);
    MorphSVGPlugin.convertToPath('#lineOne, #lineTwo, #outer, #inner');

    gsap.set('#outer, #inner', {
      morphSVG: '#dot-EX'
    });
  }

  componentDidUpdate() {
    const { isOpen } = this.props;

    if (isOpen) {
      gsap.to('#lineOne', {
        duration: 0.5,
        opacity: 1,
        morphSVG: '#lineOne-EX',
        ease: Bounce.easeOut
      });

      gsap.to('#lineTwo', {
        duration: 0.5,
        opacity: 1,
        morphSVG: '#lineTwo-EX',
        ease: Bounce.easeOut
      });

      gsap.to('#outer, #inner', {
        duration: 0.5,
        morphSVG: '#dot-EX',
        ease: Bounce.easeOut
      });
    } else {
      gsap.to('#outer', {
        duration: 0.5,
        morphSVG: '#outer',
        ease: Bounce.easeOut
      });

      gsap.to('#inner', {
        duration: 0.5,
        delay: 0.3,
        morphSVG: '#inner',
        ease: Bounce.easeOut
      });

      gsap.to('#lineOne, #lineTwo', {
        opacity: 0,
        duration: 0.5,
        morphSVG: '#center-EX',
        ease: Bounce.easeOut
      });
    }
  }

  render() {
    return (
      <svg viewBox="0 0 600 600" className="close-button">
        <circle id="outer" cx="300" cy="300" r="275" />
        <circle id="inner" cx="300" cy="300" r="180" />
        <rect
          id="lineTwo"
          x="47.6"
          y="298.5"
          transform="matrix(0.7071 0.7071 -0.7071 0.7071 300 -124.2641)"
          width="504.8"
          height="3"
        />
        <rect
          id="lineOne"
          x="47.6"
          y="298.5"
          transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 724.2641 300)"
          width="504.8"
          height="3"
        />

        <circle id="center-EX" cx="300" cy="300" r="200" />
        <circle id="dot-EX" cx="300" cy="300" r="4.6" />
        <rect
          id="lineTwo-EX"
          x="47.6"
          y="298.5"
          transform="matrix(0.7071 0.7071 -0.7071 0.7071 300 -124.2641)"
          width="504.8"
          height="3"
        />
        <rect
          id="lineOne-EX"
          x="47.6"
          y="298.5"
          transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 724.2641 300)"
          width="504.8"
          height="3"
        />
      </svg>
    );
  }
}
