import React from 'react';

export default class SettingsButton extends React.Component {
  render() {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className="settings-icon">
        {/* Bottom slider - track */}
        <path d="M16 400c-8.8 0-16 7.2-16 16v32c0 8.8 7.2 16 16 16h480c8.8 0 16-7.2 16-16v-32c0-8.8-7.2-16-16-16H16z" />
        {/* Bottom slider - knob */}
        <g className="slider-knob slider-1">
          <path d="M96 368h32c8.8 0 16 7.2 16 16v16h-64v-16c0-8.8 7.2-16 16-16z" />
          <path d="M96 448h32c8.8 0 16 7.2 16 16v16h-64v-16c0-8.8 7.2-16 16-16z" />
          <rect x="80" y="384" width="64" height="64" />
        </g>

        {/* Middle slider - track */}
        <path d="M16 240c-8.8 0-16 7.2-16 16v32c0 8.8 7.2 16 16 16h480c8.8 0 16-7.2 16-16v-32c0-8.8-7.2-16-16-16H16z" />
        {/* Middle slider - knob */}
        <g className="slider-knob slider-2">
          <path d="M368 208h32c8.8 0 16 7.2 16 16v16h-64v-16c0-8.8 7.2-16 16-16z" />
          <path d="M368 288h32c8.8 0 16 7.2 16 16v16h-64v-16c0-8.8 7.2-16 16-16z" />
          <rect x="352" y="224" width="64" height="64" />
        </g>

        {/* Top slider - track */}
        <path d="M16 80c-8.8 0-16 7.2-16 16v32c0 8.8 7.2 16 16 16h480c8.8 0 16-7.2 16-16V96c0-8.8-7.2-16-16-16H16z" />
        {/* Top slider - knob */}
        <g className="slider-knob slider-3">
          <path d="M240 48h32c8.8 0 16 7.2 16 16v16h-64V64c0-8.8 7.2-16 16-16z" />
          <path d="M240 128h32c8.8 0 16 7.2 16 16v16h-64v-16c0-8.8 7.2-16 16-16z" />
          <rect x="224" y="64" width="64" height="64" />
        </g>
      </svg>
    );
  }
}
