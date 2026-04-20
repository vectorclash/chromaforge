import React from 'react';

import './Copyright.scss';

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
      <div id="copyright">
        © {date}{' '}
        <a href="https://www.vectorclash.com" target="_blank" rel="noopener noreferrer">
          Aaron Ezra Sterczewski
        </a>
      </div>
    );
  }
}
