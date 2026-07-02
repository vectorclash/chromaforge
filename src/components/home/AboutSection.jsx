import React from 'react';
import aboutImage from '../../assets/images/about-infographic.png';
import { useScrollTriggerReveal } from '../../hooks/useScrollTriggerReveal';

// Minimal -- per the brief, this section explains the app in a few lines, not a feature
// tour. Solid surface (no live art behind it), on-system type.
export default function AboutSection() {
  const ref = useScrollTriggerReveal();
  return (
    <section id="about" ref={ref} className="mx-auto max-w-2xl px-6 py-32 text-center">
      <p className="reveal-item font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-accent">
        What this is
      </p>
      <h2 className="reveal-item mt-3 font-display text-3xl text-text">Art, generated from a seed</h2>
      <p className="reveal-item mt-5 font-quicksand text-text-secondary">
        Chromaforge composes original artwork from a random seed, live in your browser. Every
        design is reproducible from a few numbers -- the same seed always regenerates the same piece, at any size. Save your favorites, share them, or put one on a shirt.
      </p>
      <img src={aboutImage} alt="Colorful shirts being designed in outer space" className="reveal-item mx-auto mt-10 w-full max-w-md" />
    </section>
  );
}
