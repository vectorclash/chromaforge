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
        How it works
      </p>
      <h2 className="reveal-item mt-3 font-display text-3xl text-text">Art, computed from a single seed</h2>
      <p className="reveal-item mt-5 font-quicksand text-text-secondary">
        Chromaforge generates original artwork deterministically, live in your browser. Each
        design is defined by a seed -- a small set of numbers that regenerates the identical
        composition at any size, every time. Save the designs you like, share them, or print
        one on a garment.
      </p>
      <img src={aboutImage} alt="Colorful shirts being designed in outer space" className="reveal-item mx-auto mt-10 w-full max-w-md" />
    </section>
  );
}
