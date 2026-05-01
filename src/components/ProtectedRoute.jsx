import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from './LoadingSpinner.jsx';

// Sermon Archive is multi-tenant. Any authenticated user can access; RLS
// scopes their data to sermons they own. Staff users (e.g., WFUMC admin)
// can also see all sermons across users (for guest preacher workflows).
export default function ProtectedRoute({ children }) {
  const { loading, session } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingSpinner label="Checking access…" />;
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}
