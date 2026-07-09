import { MANUSCRIPT_MODEL_OPTIONS } from '../lib/manuscriptModel';
import { displayKeyForOption } from '../lib/aiModels';

// Compact dropdown for the Workspace's manuscript-model choice.
// Renders inline so it fits in the chat-input row without taking
// real estate. Pastor can change at any time — applies to the next
// revision turn, not in-flight requests.
//
// Props:
//   value     — current key (from loadManuscriptModelKey)
//   onChange  — (newKey) => void; parent persists via saveManuscriptModelKey
//   disabled  — true while a revision is in flight
//   options   — model options (registry-driven via useModelOptions
//               ('manuscript'); defaults to the hardcoded fallback)
export default function ManuscriptModelPicker({
  value,
  onChange,
  disabled,
  options = MANUSCRIPT_MODEL_OPTIONS,
}) {
  return (
    <label className="text-[11px] text-gray-600 flex items-center gap-1.5 whitespace-nowrap">
      <span>Model:</span>
      <select
        value={displayKeyForOption(options, value)}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="text-[11px] border border-gray-300 rounded px-1 py-0.5 bg-white disabled:opacity-50"
        title="Which Claude model handles manuscript writing: chat revisions, highlight-and-revise, and the Eulogy panel's outline/suggestion/narrative actions. The Creative Studio has its own picker; slide suggestions and other utilities use the default. Manage the list in Bulletin App → Settings → AI Models."
      >
        {options.map((opt) => (
          <option key={opt.key} value={opt.key} title={opt.hint || undefined}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
