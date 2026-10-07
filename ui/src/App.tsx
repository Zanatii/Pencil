import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { TopBar } from './components/TopBar'
import { HomePage } from './pages/HomePage'
import { RunPage } from './pages/RunPage'

function App() {
  return (
    <BrowserRouter>
      <TopBar />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:runId" element={<RunPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
