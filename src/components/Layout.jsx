import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import VersionStamp from './VersionStamp.jsx';
import ScrollRestoration from './ScrollRestoration.jsx';

export default function Layout() {
  const { profile, signOut, session } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <ScrollRestoration />
      <header className="bg-umc-900 text-white px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <Link to="/" className="font-serif text-lg leading-tight">
            WFUMC Sermon Archive
          </Link>
          {session && (
            <div className="flex items-center gap-3 sm:gap-4 text-sm">
              <Link
                to="/resources"
                className="text-umc-100 hover:text-white underline whitespace-nowrap"
              >
                Resources
              </Link>
              <Link
                to="/import"
                className="text-umc-100 hover:text-white underline whitespace-nowrap"
              >
                Import
              </Link>
              <span className="text-umc-100 hidden sm:inline">
                {profile?.full_name}
              </span>
              <button
                onClick={handleSignOut}
                className="text-umc-100 hover:text-white underline"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <Outlet />
        <VersionStamp />
      </main>
    </div>
  );
}
