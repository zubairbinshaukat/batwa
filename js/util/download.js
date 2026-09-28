// Tiny Blob / File download helper. Shared by backups and report exports.

/** Offer a Blob or File as a browser download. Revokes the object URL after a beat. */
export function downloadBlob(data, filename, mime = "application/octet-stream") {
  const blob = data instanceof Blob
    ? data
    : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
