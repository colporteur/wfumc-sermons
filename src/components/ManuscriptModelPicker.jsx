import { MANUSCRIPT_MODEL_OPTIONS } from '../lib/manuscriptModel';

// Compact dropdown for the Workspace's manuscript-model choice.
// Renders inline so it fits in the chat-input row without taking
// real estate. Pastor can change at any time — applies to the next
// revision turn, not in-flight requests.
//
// Props:
//   value     — current key (from loadManuscriptModelKey)
//   onChange  — (newKey) => void; parent persists via saveManuscriptModelKey
//   disabled  — true while a revision is in flight
export default function ManuscriptModelPicker({ value, onChange, disabled }) {
  return (
    <label className="text-[11px] text-gray-600 flex items-center gap-1.5 whitespace-nowrap">
      <span>Model:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="text-[11px] border border-gray-300 rounded px-1 py-0.5 bg-white disabled:opacity-50"
        title="Which Claude model handles manuscript revisions. Other Claude features (Brainstorm, slide suggestions, etc.) use the default regardless of this choice."
      >
        {MANUSCRIPT_MODEL_OPTIONS.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
