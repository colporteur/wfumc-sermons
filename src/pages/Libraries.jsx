import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  listMyLibraries,
  listLibraryMembers,
  createLibrary,
  addMemberByEmail,
  removeMember,
} from '../lib/libraries';

// Manage shared resource libraries: create one, see members, invite
// new members by email, remove members. A user can be in many libraries.
//
// Each library is a pool of resources visible to all members.
export default function Libraries() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [libraries, setLibraries] = useState([]);
  // member rows keyed by library_id
  const [membersByLib, setMembersByLib] = useState({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createErr, setCreateErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    try {
      const libs = await listMyLibraries();
      setLibraries(libs);
      const memberMap = {};
      // Fan-out members in parallel
      await Promise.all(
        libs.map(async (lib) => {
          memberMap[lib.id] = await listLibraryMembers(lib.id);
        })
      );
      setMembersByLib(memberMap);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleCreate = async () => {
    if (!user?.id) return;
    setBusy(true);
    setCreateErr(null);
    try {
      await createLibrary({ name: newName, description: newDesc }, user.id);
      setNewName('');
      setNewDesc('');
      setCreating(false);
      await reload();
    } catch (e) {
      setCreateErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading libraries…" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl text-umc-900">Libraries</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Shared collections of resources. Members of a library can see and
            edit every resource in it.
          </p>
        </div>
        <Link
          to="/resources"
          className="text-sm text-gray-500 hover:text-gray-700 underline"
        >
          ← Back to resources
        </Link>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Create new */}
      <div className="card">
        {!creating ? (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setCreateErr(null);
            }}
            className="btn-primary text-sm"
          >
            + New library
          </button>
        ) : (
          <div className="space-y-3">
            <h2 className="font-serif text-lg text-umc-900">New library</h2>
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                className="input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder='e.g., "Pastoral Resources"'
              />
            </div>
            <div>
              <label className="label">Description (optional)</label>
              <input
                type="text"
                className="input"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What's this library for?"
              />
            </div>
            {createErr && (
              <p className="text-sm text-red-600">{createErr}</p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCreate}
                disabled={busy || !newName.trim()}
                className="btn-primary disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Create library'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setCreateErr(null);
                }}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {libraries.length === 0 ? (
        <p className="card text-center text-sm text-gray-500 py-10">
          You're not in any libraries yet. Create one to start sharing resources.
        </p>
      ) : (
        <ul className="space-y-3">
          {libraries.map((lib) => (
            <LibraryCard
              key={lib.id}
              library={lib}
              members={membersByLib[lib.id] ?? []}
              currentUserId={user?.id}
              onChange={reload}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function LibraryCard({ library, members, currentUserId, onChange }) {
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  const handleAdd = async () => {
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    try {
      await addMemberByEmail(library.id, email, currentUserId);
      setOkMsg(`Added ${email}.`);
      setEmail('');
      setAdding(false);
      await onChange();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (member) => {
    const isSelf = member.user_id === currentUserId;
    const msg = isSelf
      ? `Leave "${library.name}"? You'll lose access to its resources.`
      : `Remove this member from "${library.name}"?`;
    if (!window.confirm(msg)) return;
    setRemovingId(member.user_id);
    setErr(null);
    try {
      await removeMember(library.id, member.user_id);
      await onChange();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <li className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-serif text-lg text-umc-900">{library.name}</h3>
          {library.description && (
            <p className="text-sm text-gray-600 mt-0.5">{library.description}</p>
          )}
          <p className="text-xs text-gray-400 mt-1">
            {members.length} member{members.length === 1 ? '' : 's'}
            {library.created_by === currentUserId && ' · created by you'}
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setErr(null);
              setOkMsg(null);
            }}
            className="btn-secondary text-sm whitespace-nowrap"
          >
            + Add member
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
          <label className="label">Email of person to add</label>
          <div className="flex gap-2">
            <input
              type="email"
              className="input flex-1"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@example.com"
              autoFocus
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={busy || !email.trim()}
              className="btn-primary disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setErr(null);
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-gray-500">
            They need to have signed in to the Sermon Archive at least once.
          </p>
        </div>
      )}

      {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
      {okMsg && !err && <p className="text-sm text-green-700 mt-2">{okMsg}</p>}

      <ul className="mt-3 divide-y divide-gray-100 text-sm">
        {members.map((m) => {
          const isSelf = m.user_id === currentUserId;
          return (
            <li
              key={m.user_id}
              className="py-2 flex items-center justify-between gap-2"
            >
              <span className="text-gray-700 font-mono text-xs truncate">
                {isSelf ? 'you' : m.user_id.slice(0, 8) + '…'}
                {m.user_id === library.created_by && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-400">
                    creator
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(m)}
                disabled={removingId === m.user_id}
                className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-50"
              >
                {removingId === m.user_id
                  ? 'Removing…'
                  : isSelf
                  ? 'Leave'
                  : 'Remove'}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
