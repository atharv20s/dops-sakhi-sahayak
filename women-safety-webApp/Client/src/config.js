// One backend origin for REST requests and Socket.IO.
// Vercel: set VITE_API_BASE_URL to https://<render-service>.onrender.com/api.
// Vercel: set VITE_SOCKET_URL to https://<render-service>.onrender.com.
const configuredApiBase = import.meta.env.VITE_API_BASE_URL;
export const API_BASE = (configuredApiBase || 'http://localhost:5001/api').replace(/\/+$/, '');

const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL;
export const API_ORIGIN = (
  configuredSocketUrl || API_BASE.replace(/\/api$/, '')
).replace(/\/+$/, '');
