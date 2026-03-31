import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { queryClient } from "@/lib/queryClient";
import { AuthProvider, useAuth } from "@/context/auth-context";
import LandingPage from "@/pages/landing";
import DashboardPage from "@/pages/dashboard";
import UploadPage from "@/pages/upload";
import ReportsPage from "@/pages/reports";
import BillingPage from "@/pages/billing";
import SettingsPage from "@/pages/settings";
import WhoIsThisForPage from "@/pages/who-is-this-for";
import LegalPage from "@/pages/legal";
import NotFound from "@/pages/not-found";
import CreateContractPage from "@/pages/create-contract";

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isInitializing } = useAuth();
  if (isInitializing) return null;
  if (!isAuthenticated) return <Redirect to="/" />;
  return <Component />;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/who-is-this-for" component={WhoIsThisForPage} />
      <Route path="/privacy" component={LegalPage} />
      <Route path="/terms" component={LegalPage} />
      <Route path="/security" component={LegalPage} />
      <Route path="/dashboard"><ProtectedRoute component={DashboardPage} /></Route>
      <Route path="/upload"><ProtectedRoute component={UploadPage} /></Route>
      <Route path="/reports"><ProtectedRoute component={ReportsPage} /></Route>
      <Route path="/billing"><ProtectedRoute component={BillingPage} /></Route>
      <Route path="/settings"><ProtectedRoute component={SettingsPage} /></Route>
      <Route path="/create-contract"><ProtectedRoute component={CreateContractPage} /></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router hook={useHashLocation}>
          <AppRoutes />
        </Router>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
