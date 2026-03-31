import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation, Link } from "wouter";
import { LayoutDashboard, Upload, FileText, CreditCard, Settings, LogOut, Menu, X, Coins, FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useAuth } from "@/context/auth-context";
import { useCredits } from "@/hooks/use-credits";

const navItems = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { path: "/upload", label: "Upload Contract", icon: Upload },
  { path: "/reports", label: "Reports", icon: FileText },
  { path: "/billing", label: "Billing", icon: CreditCard },
  { path: "/settings", label: "Settings", icon: Settings },
];

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user, logout } = useAuth();
  const credits = useCredits();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Prevent body scroll when sidebar drawer is open on mobile
  useEffect(() => {
    document.body.classList.toggle("overflow-hidden", sidebarOpen);
    return () => { document.body.classList.remove("overflow-hidden"); };
  }, [sidebarOpen]);

  return (
    <div className="min-h-screen bg-background flex">
      <AnimatePresence>
        {sidebarOpen && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-40 bg-black/20 lg:hidden" onClick={() => setSidebarOpen(false)} />}
      </AnimatePresence>

      <aside className={`fixed lg:sticky top-0 left-0 z-50 h-screen w-[232px] border-r border-border/60 bg-white flex flex-col transition-transform duration-200 ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        <div className="flex items-center justify-between px-5 h-14 border-b border-border/40">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Logo size={22} />
            <span className="text-sm font-semibold">clausemate<span className="text-primary">.ai</span></span>
          </Link>
          <button className="lg:hidden h-7 w-7 flex items-center justify-center rounded-md hover:bg-accent" onClick={() => setSidebarOpen(false)}><X className="h-4 w-4" /></button>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-0.5">
          {navItems.map((item) => {
            const active = location === item.path;
            return (
              <>
                <Link key={item.path} href={item.path}>
                  <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 ${active ? "bg-primary/8 text-primary shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted hover:shadow-sm hover:scale-[1.02]"}`} data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, "-")}`}>
                    <item.icon className="h-[18px] w-[18px] shrink-0" />
                    {item.label}
                  </div>
                </Link>
                {/* Insert Create Contract after Upload Contract */}
                {item.path === "/upload" && (
                  <Link href="/create-contract">
                    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium cursor-pointer transition-all duration-200 ${location === "/create-contract" ? "bg-primary/8 text-primary shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted hover:shadow-sm hover:scale-[1.02]"}`} data-testid="nav-create-contract">
                      <FileSignature className="h-[18px] w-[18px] shrink-0" />
                      <span className="flex-1">Create Contract</span>
                      {credits.plan_id === "free" && (
                        <span className="text-[9px] font-semibold text-primary/70 bg-primary/8 px-1.5 py-0.5 rounded-full border border-primary/15 leading-tight">PRO</span>
                      )}
                    </div>
                  </Link>
                )}
              </>
            );
          })}
        </nav>

        <div className="shrink-0 px-3 pb-4 space-y-2 border-t border-border/40 pt-3">
          <div className="rounded-lg border border-border/60 bg-card p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-semibold text-primary">{user?.name?.charAt(0) || "A"}</div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate">{user?.name || "User"}</p>
                <p className="text-[11px] text-primary/70 font-medium">{credits.plan_name}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Coins className="h-3 w-3" />
              <span>{credits.displayRemaining} / {credits.displayTotal} credits</span>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start text-[13px] text-muted-foreground" onClick={() => { logout(); setLocation("/"); }} data-testid="logout-btn">
            <LogOut className="h-4 w-4 mr-2" /> Sign Out
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-h-screen">
        <header className="sticky top-0 z-30 h-14 border-b border-border/40 bg-white/90 backdrop-blur-lg flex items-center px-5 gap-3">
          <button className="lg:hidden h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent" onClick={() => setSidebarOpen(true)} data-testid="mobile-menu-btn"><Menu className="h-4 w-4" /></button>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground hidden sm:flex">
            <Coins className="h-3.5 w-3.5" />
            <span>{credits.displayRemaining} credits</span>
          </div>
          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-semibold text-primary">{user?.name?.charAt(0) || "A"}</div>
        </header>
        <main className="flex-1 p-5 md:p-7 lg:p-8 bg-[hsl(230,20%,98.5%)]">
          <AnimatePresence mode="wait">
            <motion.div key={location} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
