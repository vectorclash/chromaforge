import React from 'react';

export default class Copyright extends React.Component {
  constructor() {
    super();
    this.state = {
      date: new Date().getFullYear()
    };
  }

  render() {
    const { date } = this.state;
    return (
      // `absolute` with no left/right keeps the centered static position from the
      // flex-centered `.display-canvas` parent — do not add left/right here.
      <div
        id="copyright"
        className="absolute bottom-[10px] z-[2000] font-quicksand text-[8px] text-white opacity-50"
      >
        © {date}{' '}
        <a
          className="font-bold text-white no-underline"
          href="https://www.vectorclash.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          Aaron Ezra Sterczewski
        </a>
      </div>
    );
  }
}
