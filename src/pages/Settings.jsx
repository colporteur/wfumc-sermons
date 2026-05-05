import { Link } from 'react-router-dom';

// /settings — small index page that links to the individual settings
// pages (voice guide, print preferences, future ones). Keeps the top
// nav from getting cluttered as more pages get added.
export default function Settings() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
          ← Sermons
        </Link>
        <h1 className="font-serif text-2xl text-umc-900 mt-2">Settings</h1>
        <p className="text-sm text-gray-600 mt-1">
          Personal preferences for sermon writing and export.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SettingsCard
          to="/settings/voice"
          title="Pastoral voice guide"
          description="How Claude should sound when it drafts or revises sermons in the Workspace. Includes pinned exemplar sermons."
        />
        <SettingsCard
          to="/settings/print"
          title="Print preferences"
          description="Defaults for the Word manuscript exporter — font, size, line spacing, margins, page numbers, header text."
        />
      </div>
    </div>
  );
}

function SettingsCard({ to, title, description }) {
  return (
    <Link
      to={to}
      className="card hover:border-umc-700 hover:shadow-md transition group block"
    >
      <h2 className="font-serif text-lg text-umc-900 group-hover:text-umc-700">
        {title} →
      </h2>
      <p className="text-sm text-gray-600 mt-1">{description}</p>
    </Link>
  );
}
