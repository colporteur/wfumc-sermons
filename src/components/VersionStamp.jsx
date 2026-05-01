/* global __BUILD_TIME__, __BUILD_SHA__ */
const buildTime = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
const buildSha = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'local';

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi} UTC`;
}

export default function VersionStamp() {
  return (
    <p className="no-print text-[11px] text-gray-500 text-center mt-4">
      v {fmt(buildTime)} · {buildSha}
    </p>
  );
}
