// Single source for "is this a phone/tablet". The same UA regex was previously inlined in
// StudioPage (choosing the studio render size) and twice in DisplayCanvas (export size,
// export bitrate) — three copies that had to agree for the memory budget below to hold.
export function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}
