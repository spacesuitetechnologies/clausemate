import { Link, useRoute } from "wouter";

function LegalNav() {
  return (
    <nav className="border-b border-border/60 bg-white">
      <div className="max-w-[760px] mx-auto flex items-center justify-between px-6 h-16">
        <Link href="/" className="flex items-center">
          <span className="text-[15px] font-semibold tracking-tight text-foreground">clausemate<span className="text-primary">.ai</span></span>
        </Link>
        <Link href="/"><span className="text-[13px] text-muted-foreground hover:text-foreground cursor-pointer">Back to Home</span></Link>
      </div>
    </nav>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      <div className="text-[13px] text-muted-foreground leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

function PrivacyContent() {
  return (
    <>
      <h1 className="font-display text-2xl mb-2">Privacy Policy</h1>
      <p className="text-xs text-muted-foreground mb-8">Last updated: March 2026</p>

      <Section title="Data We Collect">
        <p>We collect your email address and name when you create an account. When you upload a contract for analysis, the document content is processed by our AI engine to generate risk assessments.</p>
      </Section>
      <Section title="How We Handle Your Documents">
        <p>Uploaded contracts are processed securely and are not stored permanently on our servers. Documents are deleted after analysis is complete. We do not use your contract data to train our AI models.</p>
      </Section>
      <Section title="Data Sharing">
        <p>We do not sell, rent, or share your personal data or contract content with any third parties. Your data is yours.</p>
      </Section>
      <Section title="Cookies & Analytics">
        <p>We use minimal analytics to understand product usage. No advertising trackers are used.</p>
      </Section>
      <Section title="Contact">
        <p>For privacy-related inquiries, reach us at +91-8680805505.</p>
      </Section>
    </>
  );
}

function TermsContent() {
  return (
    <>
      <h1 className="font-display text-2xl mb-2">Terms of Service</h1>
      <p className="text-xs text-muted-foreground mb-8">Last updated: March 2026</p>

      <Section title="Nature of Service">
        <p>clausemate.ai is an AI-powered contract analysis tool. It is not a law firm, does not provide legal advice, and is not a substitute for professional legal counsel. All analysis outputs are informational only.</p>
      </Section>
      <Section title="Usage Limits">
        <p>Each plan has defined contract analysis limits per month. Exceeding these limits requires upgrading your plan. We reserve the right to modify usage limits with reasonable notice.</p>
      </Section>
      <Section title="Limitation of Liability">
        <p>clausemate.ai shall not be held liable for any decisions made based on AI-generated analysis. Users are responsible for verifying all findings with qualified legal professionals before acting on them.</p>
      </Section>
      <Section title="Acceptable Use">
        <p>You agree to use the platform for lawful contract review purposes only. Uploading illegal, fraudulent, or harmful content is strictly prohibited.</p>
      </Section>
      <Section title="Modifications">
        <p>We may update these terms from time to time. Continued use of the service constitutes acceptance of the updated terms.</p>
      </Section>
    </>
  );
}

function SecurityContent() {
  return (
    <>
      <h1 className="font-display text-2xl mb-2">Security</h1>
      <p className="text-xs text-muted-foreground mb-8">Last updated: March 2026</p>

      <Section title="Encryption">
        <p>All data in transit is encrypted using TLS 1.3. Uploaded documents are encrypted at rest using AES-256 encryption during the brief processing period.</p>
      </Section>
      <Section title="Secure Processing">
        <p>Contract analysis happens in isolated, ephemeral processing environments. Documents are not retained after analysis is complete. No human reviews your contracts during the analysis process.</p>
      </Section>
      <Section title="Access Control">
        <p>Your account is protected by password authentication. We support Google OAuth for secure sign-in. We do not share access to your data with unauthorized parties.</p>
      </Section>
      <Section title="Infrastructure">
        <p>We use industry-standard cloud infrastructure with regular security audits and monitoring. Our systems are designed to detect and prevent unauthorized access.</p>
      </Section>
      <Section title="Reporting Vulnerabilities">
        <p>If you discover a security vulnerability, please contact us at +91-8680805505. We take all reports seriously.</p>
      </Section>
    </>
  );
}

export default function LegalPage() {
  const [isPrivacy] = useRoute("/privacy");
  const [isTerms] = useRoute("/terms");
  const [isSecurity] = useRoute("/security");

  return (
    <div className="min-h-screen bg-background">
      <LegalNav />
      <div className="max-w-[620px] mx-auto px-6 py-16">
        {isPrivacy && <PrivacyContent />}
        {isTerms && <TermsContent />}
        {isSecurity && <SecurityContent />}
      </div>
      <footer className="border-t border-border/60 py-8 px-6">
        <div className="max-w-[1140px] mx-auto text-center text-[11px] text-muted-foreground">
          © 2026 Spacesuite Technologies LLP
        </div>
      </footer>
    </div>
  );
}
