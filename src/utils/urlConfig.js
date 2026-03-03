// Utility functions for encoding/decoding configuration to/from URL
// Uses localStorage for large configs that exceed URL limits

const MAX_URL_LENGTH = 2000; // Safe limit for most browsers

function generateShortId() {
  return Math.random().toString(36).substring(2, 9);
}

export function encodeConfigToUrl(config) {
  try {
    const jsonString = JSON.stringify(config);
    const base64 = btoa(jsonString);
    // Make URL-safe by replacing characters
    const urlSafe = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return urlSafe;
  } catch (error) {
    console.error('Error encoding config:', error);
    return null;
  }
}

export function decodeConfigFromUrl(encoded) {
  try {
    // Restore base64 characters
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    while (base64.length % 4) {
      base64 += '=';
    }
    const jsonString = atob(base64);
    const config = JSON.parse(jsonString);
    return config;
  } catch (error) {
    console.error('Error decoding config:', error);
    return null;
  }
}

export function getConfigFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);

  // Check for short ID first (localStorage reference)
  const shortId = urlParams.get('id');
  if (shortId) {
    const stored = localStorage.getItem(`chromaforge_${shortId}`);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (error) {
        console.error('Error loading from localStorage:', error);
      }
    }
  }

  // Fall back to inline config
  const encoded = urlParams.get('config');
  if (encoded) {
    return decodeConfigFromUrl(encoded);
  }

  return null;
}

export function generateShareUrl(config) {
  const encoded = encodeConfigToUrl(config);
  if (!encoded) return null;

  const baseUrl = window.location.origin + window.location.pathname;
  const testUrl = `${baseUrl}?config=${encoded}`;

  // If URL is too long, use localStorage with short ID
  if (testUrl.length > MAX_URL_LENGTH) {
    const shortId = generateShortId();
    try {
      localStorage.setItem(`chromaforge_${shortId}`, JSON.stringify(config));
      return `${baseUrl}?id=${shortId}`;
    } catch (error) {
      console.error('localStorage not available, URL may be too long:', error);
      // Fall back to long URL even though it might not work
      return testUrl;
    }
  }

  return testUrl;
}
