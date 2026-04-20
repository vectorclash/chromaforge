import React from 'react';
import './App.scss';

import DisplayCanvas from './components/DisplayCanvas';

export default function App() {
  let width = 3840;
  let height = 2160;

  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
    width = 2160;
    height = 2160;
  }

  return (
    <div className="App">
      <DisplayCanvas width={width} height={height} />
    </div>
  );
}
