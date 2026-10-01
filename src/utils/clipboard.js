// Copy text, resolving true/false rather than throwing. navigator.clipboard.writeText
// rejects in some real contexts (no document focus, an iframe without clipboard-write,
// insecure origin), so it falls back to a selected textarea + execCommand -- the same pair
// DisplayCanvas's own share-link copy uses (see copyToClipboard there).
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
