import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from './LoadingSpinner.jsx';

export default function ProtectedRoute({ children }) {
  const { loading, session, isStaff } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingSpinner label="Checking access…" />;
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!isStaff) {
    return (
      <div className="max-w-lg mx-auto mt-12 p-6 text-center space-y-4">
        <h1 className="text-xl font-semibold">No staff profile</h1>
        <p className="text-gray-600 text-sm">
          You're signed in, but no staff profile is loaded for this user.
          The Sermon Archive is restricted to church staff.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn-primary"
        >
          Reload
        </button>
      </div>
    );
  }

  return children;
}
