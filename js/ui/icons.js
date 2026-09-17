// Inline SVG icon library — stroke-based, inherits currentColor, zero assets.
// Usage: icon("check", 18) -> svg string.

const PATHS = {
  check:        '<path d="M20 6 9 17l-5-5"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>',
  x:            '<path d="M18 6 6 18M6 6l12 12"/>',
  plus:         '<path d="M12 5v14M5 12h14"/>',
  trash:        '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  banknote:     '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  receipt:      '<path d="M5 2.5 6.5 3.5 8 2.5 9.5 3.5 11 2.5 12.5 3.5 14 2.5 15.5 3.5 17 2.5 19 3.5V21.5l-2-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1-2-1V3.5z" transform="translate(0,-0.5)"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  cloud:        '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  "cloud-off":  '<path d="M2 2l20 20M9.34 5.34A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 3.2 7.68M5.33 8.5A7 7 0 0 0 9 19h8.5"/>',
  refresh:      '<path d="M3 12a9 9 0 0 1 15.36-6.36L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.36 6.36L3 16"/><path d="M3 21v-5h5"/>',
  upload:       '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download:     '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  lock:         '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  fingerprint:  '<path d="M2 12a10 10 0 0 1 15-8.7M22 12a10 10 0 0 1-.6 3.4"/><path d="M5.6 18.4A8 8 0 0 1 12 5.5a6.5 6.5 0 0 1 6.5 6.5c0 1.2-.1 2.4-.4 3.5"/><path d="M8.5 20.6A10.5 10.5 0 0 0 12 12"/><path d="M12 8.5a3.5 3.5 0 0 1 3.5 3.5c0 2.6-.4 5.1-1.2 7.5"/><path d="M11.5 15.5a19 19 0 0 1-.7 5.9"/>',
  tag:          '<path d="M2 2h9.2a2 2 0 0 1 1.4.6l9 9a2 2 0 0 1 0 2.8l-6.2 6.2a2 2 0 0 1-2.8 0l-9-9A2 2 0 0 1 3 10.2V2z" transform="translate(0.5,0.5) scale(0.92)"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  "credit-card": '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/>',
  smartphone:   '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11.2 18h1.6"/>',
  alert:        '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  sparkles:     '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>',
  scale:        '<path d="M12 3v18M7 21h10M3 7h18"/><path d="m6 7-3 7c1.8 1.4 4.2 1.4 6 0L6 7zM18 7l-3 7c1.8 1.4 4.2 1.4 6 0l-3-7z"/>',
  "trend-up":   '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  "trend-down": '<path d="M22 17l-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
  repeat:       '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  graduation:   '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12.5V17c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/>',
  home:         '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>',
  utensils:     '<path d="M4 2v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V2M7 2v20"/><path d="M19 15V2a4 4 0 0 0-4 4v7a2 2 0 0 0 2 2h2zm0 0v7"/>',
  car:          '<path d="M5 11l1.6-4.8A2 2 0 0 1 8.5 5h7a2 2 0 0 1 1.9 1.2L19 11"/><rect x="3" y="11" width="18" height="7" rx="2"/><path d="M7.5 14.5h.01M16.5 14.5h.01"/>',
  book:         '<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2V4z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7V4z"/>',
  zap:          '<path d="M13 2 3 14h8l-1 8 11-12h-9l1-8z"/>',
  heart:        '<path d="M19.5 13c1.4-1.4 2.5-3 2.5-4.9A4.6 4.6 0 0 0 17.4 3.5c-2.2 0-3.7 1.1-5.4 3-1.7-1.9-3.2-3-5.4-3A4.6 4.6 0 0 0 2 8.1C2 10 3.1 11.6 4.5 13l7.5 7.5L19.5 13z"/><path d="M7 12h2.5l1.5-2.5 2 4 1.5-2.5H17"/>',
  bag:          '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4H6z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  landmark:     '<path d="M3 22h18M12 2 2.5 8h19L12 2z"/><path d="M5 11v7M9.5 11v7M14.5 11v7M19 11v7"/>',
  box:          '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3.3 7.9 12 13l8.7-5.1"/><path d="M12 22V13"/>',
  inbox:        '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  sun:          '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon:         '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sprout:       '<path d="M12 21V9"/><path d="M12 9c0-3.3 2.7-6 6-6h2v1c0 3.3-2.7 6-6 6h-2zM12 13c0-2.8-2.2-5-5-5H4v1c0 2.8 2.2 5 5 5h3"/><path d="M6 21h12"/>',
  frown:        '<circle cx="12" cy="12" r="9"/><path d="M16 16.5s-1.5-2-4-2-4 2-4 2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  "bar-chart":  '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  dot:          '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  "circle-dash": '<circle cx="12" cy="12" r="8.5" stroke-dasharray="4 4"/>',
  eye:          '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off":    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
  settings:     '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  wallet:       '<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M22 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h18V7z" transform="scale(0.95) translate(0.6,0.6)"/><path d="M17.5 14h.01"/>',
  undo:         '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  "chevron-left":  '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  clock:        '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list:         '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  swap:         '<path d="m17 3 4 4-4 4"/><path d="M3 7h18"/><path d="m7 21-4-4 4-4"/><path d="M21 17H3"/>',
  grip:         '<circle cx="9" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1.4" fill="currentColor" stroke="none"/>',

  /* ---- Filled nav variants: the active tab. Same silhouettes as the
     outline set, so the swap reads as a weight change, not a new icon. ---- */
  "home-fill":  '<path fill="currentColor" stroke="none" d="M12.65 2.76a1 1 0 0 0-1.3 0L2.6 10.4a1 1 0 0 0 .65 1.75H4.5V20a1.5 1.5 0 0 0 1.5 1.5h3.25V15.6a2.75 2.75 0 0 1 5.5 0v5.9H18a1.5 1.5 0 0 0 1.5-1.5v-7.85h1.25a1 1 0 0 0 .65-1.75Z"/>',
  "bar-chart-fill": '<rect x="3.4" y="9.4" width="3.2" height="10.6" rx="1.6" fill="currentColor" stroke="none"/><rect x="9.4" y="3.4" width="3.2" height="16.6" rx="1.6" fill="currentColor" stroke="none"/><rect x="15.4" y="12.4" width="3.2" height="7.6" rx="1.6" fill="currentColor" stroke="none"/><rect x="2" y="19.1" width="20" height="1.9" rx=".95" fill="currentColor" stroke="none"/>',
  "clock-fill": '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="M12 7.2v5l2.9 1.9" stroke="#fff" stroke-width="2" fill="none"/>',
  "settings-fill": '<path fill="currentColor" fill-rule="evenodd" stroke="none" d="M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Zm0 4.6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/><path stroke="currentColor" stroke-width="2.8" d="M12 3.1v1.9M12 20.9v-1.9M3.1 12h1.9M20.9 12h-1.9M5.25 5.25l1.9 1.9M18.75 18.75l-1.9-1.9M5.25 18.75l1.9-1.9M18.75 5.25l-1.9 1.9"/>',
};

/** Returns an inline SVG string. Icons inherit currentColor. */
export function icon(name, size = 18, cls = "") {
  const body = PATHS[name] || PATHS.box;
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Category -> icon name (Others is the fallback). */
const CAT_ICONS = {
  "Fees": "graduation",
  "Rent/Hostel": "home",
  "Food": "utensils",
  "Transport": "car",
  "Education": "book",
  "Bills": "zap",
  "Health": "heart",
  "Shopping": "bag",
  "Savings": "landmark",
  "Others": "box",
};

export function catIcon(category, size = 14) {
  return icon(CAT_ICONS[category] || "box", size);
}
