import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { ShieldCheck, HeartPulse } from 'lucide-react';
import SarthiMap from './SarthiMap';
import { API_ORIGIN } from '../config';

const socket = io(API_ORIGIN);

export default function FamilyDashboard() {
  const [trackedUsers, setTrackedUsers] = useState({});

  useEffect(() => {
    socket.on('family-dashboard-sync', (data) => {
      setTrackedUsers(data);
    });

    socket.on('emergency-broadcast-sent', (emergencyNode) => {
      alert(`🚨 CRITICAL EMERGENCY ALERT 🚨\nContact: User GPS Lock Active on Node ${emergencyNode.source}\nDispatching Police!`);
    });

    return () => {
      socket.off('family-dashboard-sync');
      socket.off('emergency-broadcast-sent');
    };
  }, []);

  const totalTracked = Object.keys(trackedUsers).length;
  // Just grabbing the first user for simplicity of the Map center in Demo
  const firstUserLoc = totalTracked > 0 ? Object.values(trackedUsers)[0] : { lat: 28.6139, lng: 77.2090 };

  return (
    <div className="app-container dashboard-layout nested-dash">
      
      <aside className="sidebar">
        <h2 className="gradient-text" style={{ fontSize: '1.6rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShieldCheck /> Family Tracking Portal
        </h2>
        <p style={{ color: '#94A3B8', fontSize: '0.9rem' }}>Live feed for people you choose. Do not post this link publicly.</p>

        <div className="card glass">
          <h3><HeartPulse size={20} color="#10B981" /> Active Travelers</h3>
          {totalTracked === 0 ? (
            <p style={{ color: '#F87171' }}>No family members are currently traveling with Sakhi-Sahayak active.</p>
          ) : (
             <p style={{ color: '#34D399', fontWeight: 'bold' }}>{totalTracked} connected right now.</p>
          )}

          {Object.entries(trackedUsers).map(([id, loc]) => (
             <div key={id} style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', marginTop: '10px', borderRadius: '8px' }}>
               <p style={{ color: '#60A5FA', fontSize: '0.8rem' }}>Session: {id.substring(0,8)}</p>
               <p style={{ fontSize: '0.8rem' }}>Live Lat: {loc.lat.toFixed(5)}</p>
               <p style={{ fontSize: '0.8rem' }}>Live Lng: {loc.lng.toFixed(5)}</p>
             </div>
          ))}
        </div>
      </aside>

      <main style={{ padding: '1rem' }}>
        <div className="glass" style={{ height: '100%', width: '100%' }}>
          {totalTracked > 0 ? (
             <SarthiMap location={firstUserLoc} dangerZones={[]} isSOS={false} isSarthiActive={false} />
          ) : (
             <div style={{ display: 'flex', height: '100%', justifyContent: 'center', alignItems: 'center' }}>
               <h2 style={{ color: '#475569' }}>Awaiting Passenger Connection...</h2>
             </div>
          )}
        </div>
      </main>
    </div>
  );
}
