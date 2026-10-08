import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { LiveProvider } from './lib/live';
import { MetaProvider, useMeta } from './lib/meta';
import { ToastProvider, Loading } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { AdminDashboard } from './pages/AdminDashboard';
import { StaffDashboard } from './pages/StaffDashboard';
import { Orders } from './pages/Orders';
import { OrderDetail } from './pages/OrderDetail';
import { NewOrder } from './pages/NewOrder';
import { MasterProduction } from './pages/MasterProduction';
import { JobSheets } from './pages/JobSheets';
import { JobSheet } from './pages/JobSheet';
import { Inventory } from './pages/Inventory';
import { MaterialDetail } from './pages/MaterialDetail';
import { Dispatch } from './pages/Dispatch';
import { Reports } from './pages/Reports';
import { Staff } from './pages/Staff';
import { ActivityLog } from './pages/ActivityLog';
import { Notifications } from './pages/Notifications';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="page"><Loading rows={4} /></div>;
  if (!user) return <Login />;
  return (
    <LiveProvider>
      <MetaProvider>
        <Shell />
      </MetaProvider>
    </LiveProvider>
  );
}

function Shell() {
  const meta = useMeta();
  const admin = useAuth().user!.role === 'admin';
  if (!meta) return <div className="page"><Loading rows={4} /></div>;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={admin ? <AdminDashboard /> : <StaffDashboard />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/new" element={admin ? <NewOrder /> : <Navigate to="/orders" />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/production" element={<MasterProduction />} />
        <Route path="/jobs" element={<JobSheets />} />
        <Route path="/my-jobs" element={<JobSheets mine />} />
        <Route path="/jobs/:id" element={<JobSheet />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/inventory/:id" element={<MaterialDetail />} />
        <Route path="/notifications" element={<Notifications />} />
        {admin && (
          <>
            <Route path="/dispatch" element={<Dispatch />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/staff" element={<Staff />} />
            <Route path="/activity" element={<ActivityLog />} />
            <Route path="/settings" element={<SettingsPage />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}
