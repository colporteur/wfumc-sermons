import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';
import SermonList from './pages/SermonList.jsx';
import SermonDetail from './pages/SermonDetail.jsx';
import SermonNew from './pages/SermonNew.jsx';
import Import from './pages/Import.jsx';
import ResourceList from './pages/ResourceList.jsx';
import ResourceNew from './pages/ResourceNew.jsx';
import ResourceDetail from './pages/ResourceDetail.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<SermonList />} />
        <Route path="/sermons/new" element={<SermonNew />} />
        <Route path="/sermons/:id" element={<SermonDetail />} />
        <Route path="/resources" element={<ResourceList />} />
        <Route path="/resources/new" element={<ResourceNew />} />
        <Route path="/resources/:id" element={<ResourceDetail />} />
        <Route path="/import" element={<Import />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center space-y-4">
        <h1 className="font-serif text-3xl text-umc-900">Page not found</h1>
        <a href="/" className="btn-primary inline-block">
          Back to sermons
        </a>
      </div>
    </div>
  );
}
