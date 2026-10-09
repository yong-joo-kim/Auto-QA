import { Navigate, Route, Routes } from 'react-router-dom';
import { TranscriptNewPage } from './pages/TranscriptNewPage';
import { TranscriptResultPage } from './pages/TranscriptResultPage';
import { EvalSheetsPage } from './pages/EvalSheetsPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/transcripts/new" replace />} />
      <Route path="/transcripts/new" element={<TranscriptNewPage />} />
      <Route path="/transcripts/:id" element={<TranscriptResultPage />} />
      <Route path="/eval-sheets" element={<EvalSheetsPage />} />
      <Route path="*" element={<Navigate to="/transcripts/new" replace />} />
    </Routes>
  );
}
