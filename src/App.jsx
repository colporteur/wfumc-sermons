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
import ResourceExtract from './pages/ResourceExtract.jsx';
import PdfSplit from './pages/PdfSplit.jsx';
import Libraries from './pages/Libraries.jsx';
import ImportResources from './pages/ImportResources.jsx';
import LiturgyList from './pages/LiturgyList.jsx';
import LiturgyDetail from './pages/LiturgyDetail.jsx';
import LiturgyImport from './pages/LiturgyImport.jsx';
import LiturgyReview from './pages/LiturgyReview.jsx';
import VoiceGuide from './pages/VoiceGuide.jsx';
import PrintPreferences from './pages/PrintPreferences.jsx';
import Settings from './pages/Settings.jsx';
import SermonWorkspace from './pages/SermonWorkspace.jsx';
import SermonNewWorkspace from './pages/SermonNewWorkspace.jsx';

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
        <Route path="/sermons/new/workspace" element={<SermonNewWorkspace />} />
        <Route path="/sermons/:id" element={<SermonDetail />} />
        <Route path="/sermons/:id/workspace" element={<SermonWorkspace />} />
        <Route path="/resources" element={<ResourceList />} />
        <Route path="/resources/new" element={<ResourceNew />} />
        <Route path="/resources/extract" element={<ResourceExtract />} />
        <Route path="/resources/pdf-split" element={<PdfSplit />} />
        <Route path="/resources/:id" element={<ResourceDetail />} />
        <Route path="/libraries" element={<Libraries />} />
        <Route path="/import-resources" element={<ImportResources />} />
        <Route path="/import" element={<Import />} />
        <Route path="/liturgies" element={<LiturgyList />} />
        <Route path="/liturgies/import" element={<LiturgyImport />} />
        <Route path="/liturgies/review" element={<LiturgyReview />} />
        <Route path="/liturgies/:id" element={<LiturgyDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/voice" element={<VoiceGuide />} />
        <Route path="/settings/print" element={<PrintPreferences />} />
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
