// API origin can be configured per deployment (for example, VITE_API_BASE_URL on Vercel).
// Keep localhost as the development fallback.
const configuredApiBase = import.meta.env.VITE_API_BASE_URL;

export const API_BASE = (configuredApiBase || 'http://localhost:5001/api').replace(/\/$/, '');
