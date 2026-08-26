import React from 'react';

// A native range input that separates "the thumb moved" from "the user is done adjusting".
//
// React's `onChange` on a range input is really the `input` event, which fires on every
// pixel of a drag. The studio's settings panel answers a settings change by regenerating
// the current seed at full studio resolution, so applying those directly meant a drag kicked
// off a fresh render every time the user paused for longer than the parent's debounce window
// -- the artwork thrashing underneath you while you are still aiming at a value. The native
// `change` event fires once on pointer release (and once per keyboard step), so that is the
// "done choosing" signal, and it has to come from a real DOM listener because React exposes
// no prop for it.
//
// This is the same split, for the same reason, that ColorField gives the jscolor swatch --
// see the pointer-tracker comment at the top of that file.
//
// `onDrag` still fires throughout, so the parent keeps the value readout and the fill track
// live: what waits for the release is the expensive work, not the control's own feedback.
export default class SettingsRange extends React.Component {
  constructor(props) {
    super(props);
    // Bound once so add/removeEventListener share the same reference -- .bind() returns a
    // new function every call, which is how ColorField once leaked its drag listeners.
    this.boundCommit = this.handleCommit.bind(this);
  }

  componentDidMount() {
    this.input?.addEventListener('change', this.boundCommit);
  }

  componentWillUnmount() {
    this.input?.removeEventListener('change', this.boundCommit);
  }

  handleCommit(e) {
    this.props.onCommit?.(Number(e.target.value));
  }

  render() {
    const { onCommit, onDrag, ...rest } = this.props;
    return (
      <input
        {...rest}
        type="range"
        ref={el => {
          this.input = el;
        }}
        onChange={e => onDrag?.(Number(e.target.value))}
      />
    );
  }
}
