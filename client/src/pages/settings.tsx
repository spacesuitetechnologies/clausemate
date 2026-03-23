import { useState } from "react";
import { motion } from "framer-motion";
import { User, Bell, Shield, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useAuth } from "@/context/auth-context";

function SettingsContent() {
  const { user } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [riskAlerts, setRiskAlerts] = useState(true);

  return (
    <div className="max-w-[600px] space-y-6">
      <div><h1 className="text-xl font-semibold mb-1">Settings</h1><p className="text-sm text-muted-foreground">Manage your account and preferences.</p></div>

      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-white p-6">
        <div className="flex items-center gap-2 mb-4"><User className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-semibold">Profile</h2></div>
        <div className="space-y-4">
          <div><label className="text-[12px] font-medium mb-1.5 block">Full Name</label><Input value={name} onChange={e => setName(e.target.value)} className="h-10 text-[13px]" data-testid="settings-name-input" /></div>
          <div><label className="text-[12px] font-medium mb-1.5 block">Email</label><Input value={email} onChange={e => setEmail(e.target.value)} className="h-10 text-[13px]" data-testid="settings-email-input" /></div>
          <Button size="sm" data-testid="save-profile-btn">Save Changes</Button>
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }} className="rounded-xl border border-border bg-white p-6">
        <div className="flex items-center gap-2 mb-4"><Bell className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-semibold">Notifications</h2></div>
        <div className="space-y-4">
          <div className="flex items-center justify-between"><div><p className="text-[13px] font-medium">Email Notifications</p><p className="text-[12px] text-muted-foreground">Get notified when analysis is complete</p></div><Switch checked={emailNotifs} onCheckedChange={setEmailNotifs} data-testid="email-notifs-switch" /></div>
          <div className="flex items-center justify-between"><div><p className="text-[13px] font-medium">High Risk Alerts</p><p className="text-[12px] text-muted-foreground">Instant alerts for high-risk clauses</p></div><Switch checked={riskAlerts} onCheckedChange={setRiskAlerts} data-testid="risk-alerts-switch" /></div>
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }} className="rounded-xl border border-border bg-white p-6">
        <div className="flex items-center gap-2 mb-4"><Shield className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-semibold">Security</h2></div>
        <div className="space-y-4">
          <div className="flex items-center justify-between"><div><p className="text-[13px] font-medium">Change Password</p><p className="text-[12px] text-muted-foreground">Update your account password</p></div><Button variant="outline" size="sm" data-testid="change-password-btn"><Key className="h-3.5 w-3.5 mr-1.5" /> Change</Button></div>
          <div className="flex items-center justify-between"><div><p className="text-[13px] font-medium">Two-Factor Authentication</p><p className="text-[12px] text-muted-foreground">Add an extra layer of security</p></div><Button variant="outline" size="sm" data-testid="2fa-btn">Enable</Button></div>
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }} className="rounded-xl border border-destructive/20 bg-destructive/[0.02] p-6">
        <h2 className="text-sm font-semibold text-destructive mb-2">Danger Zone</h2>
        <p className="text-[12px] text-muted-foreground mb-4">Permanently delete your account and all data.</p>
        <Button variant="destructive" size="sm" data-testid="delete-account-btn">Delete Account</Button>
      </motion.div>
    </div>
  );
}

export default function SettingsPage() { return <DashboardLayout><SettingsContent /></DashboardLayout>; }
