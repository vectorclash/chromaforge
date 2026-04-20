import React, { useEffect, useRef } from 'react';
import { gsap, MorphSVGPlugin } from 'gsap/all';
import './PlayPauseButton.scss';

gsap.registerPlugin(MorphSVGPlugin);

export default function PlayPauseButton({ paused }) {
  const isFirstRender = useRef(true);

  useEffect(() => {
    MorphSVGPlugin.convertToPath(
      '#pp-bar1, #pp-bar2, #pp-play1, #pp-play2, #pp-pause1, #pp-pause2'
    );
  }, []);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (paused) {
      gsap.to('#pp-bar1', { duration: 0.45, morphSVG: '#pp-play1', ease: 'bounce.out' });
      gsap.to('#pp-bar2', { duration: 0.45, morphSVG: '#pp-play2', ease: 'bounce.out' });
    } else {
      gsap.to('#pp-bar1', { duration: 0.45, morphSVG: '#pp-pause1', ease: 'bounce.out' });
      gsap.to('#pp-bar2', { duration: 0.45, morphSVG: '#pp-pause2', ease: 'bounce.out' });
    }
  }, [paused]);

  return (
    <svg viewBox="0 0 600 600" className="play-pause-button">
      {/* Active shapes */}
      <rect id="pp-bar1" x="170" y="115" width="110" height="370" rx="18" />
      <rect id="pp-bar2" x="320" y="115" width="110" height="370" rx="18" />

      {/* Hidden morph targets */}
      {/* Play arrow split into two quads — bar1 shears into the back, bar2 collapses into the tip */}
      <polygon id="pp-play1" points="170,115 320,205 320,395 170,485" />
      <polygon id="pp-play2" points="320,205 480,300 480,300 320,395" />
      {/* Pause bar mirrors used for morph-back */}
      <rect id="pp-pause1" x="170" y="115" width="110" height="370" rx="18" />
      <rect id="pp-pause2" x="320" y="115" width="110" height="370" rx="18" />
    </svg>
  );
}
