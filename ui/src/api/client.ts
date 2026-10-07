import axios from 'axios'

// Points directly at the PO Agent FastAPI backend (see po_agent/api/main.py,
// which enables CORS for the Vite dev origin below).
export const apiClient = axios.create({
  baseURL: 'http://127.0.0.1:8010',
})
