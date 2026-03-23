/**
 * Mock data for demo/UI purposes.
 * Plan types are now in credits.ts — this file only holds contract mock data.
 */

// Re-export PlanId for any file still importing Plan from here
export type { PlanId as Plan } from "./credits";

// Mock contract text for demo
export const demoContractText = `CONSULTING SERVICES AGREEMENT

This Consulting Services Agreement ("Agreement") is entered into as of March 15, 2026, between TechVentures India Pvt. Ltd. ("Company"), a company incorporated under the Companies Act, 2013, with its registered office at Bengaluru, Karnataka, and the Consultant ("Consultant").

1. SCOPE OF SERVICES
The Consultant shall provide strategic technology consulting services including but not limited to software architecture review, code audits, performance optimization, and technical due diligence as directed by the Company from time to time.

2. COMPENSATION
The Company shall pay the Consultant a monthly retainer of ₹2,50,000 (Indian Rupees Two Lakh Fifty Thousand) payable within 45 business days of receipt of a valid invoice. Late payments shall not accrue any interest or penalty.

3. INTELLECTUAL PROPERTY
All work product, inventions, discoveries, and innovations conceived, developed, or produced by the Consultant during the term of this Agreement, whether or not in the course of performing the Services, shall be the sole and exclusive property of the Company. The Consultant hereby assigns all rights, title, and interest, including all intellectual property rights worldwide, in perpetuity, to the Company.

4. NON-COMPETE CLAUSE
During the term of this Agreement and for a period of 24 months following termination, the Consultant shall not directly or indirectly engage in, or provide services to, any business that competes with the Company's business anywhere in India, Southeast Asia, or the Middle East.

5. TERMINATION
The Company may terminate this Agreement at any time, for any reason, with or without cause, by providing 7 days written notice. The Consultant may terminate only upon 90 days prior written notice and after all assigned projects are completed to the Company's satisfaction.

6. LIABILITY AND INDEMNIFICATION
The Consultant agrees to indemnify and hold harmless the Company from any and all claims, damages, losses, and expenses arising from or related to the Consultant's services, regardless of fault. The Company's total liability under this Agreement shall not exceed the last monthly payment made to the Consultant.

7. DISPUTE RESOLUTION
Any disputes arising under this Agreement shall be resolved exclusively through binding arbitration in Bengaluru, India, under the Arbitration and Conciliation Act, 1996. The arbitration shall be conducted in English by a sole arbitrator appointed by the Company.

8. GOVERNING LAW
This Agreement shall be governed by and construed in accordance with the laws of India, subject to the exclusive jurisdiction of the courts of Bengaluru, Karnataka.`;

// Mock analysis result clauses
export interface ClauseAnalysis {
  id: string;
  title: string;
  text: string;
  riskLevel: "high" | "medium" | "low";
  explanation: string;
  suggestedRewrite: string;
}

export const mockClauses: ClauseAnalysis[] = [
  {
    id: "1",
    title: "Late Payment Terms",
    text: "Late payments shall not accrue any interest or penalty.",
    riskLevel: "high",
    explanation: "This clause eliminates your right to charge interest on late payments, which is disadvantageous. Under Indian contract law and the MSME Development Act, 2006, delayed payments beyond 45 days can attract compound interest. This clause waives that statutory protection.",
    suggestedRewrite: "Late payments beyond 30 days from invoice date shall accrue interest at the rate of 1.5% per month or the rate prescribed under the MSME Development Act, 2006, whichever is higher.",
  },
  {
    id: "2",
    title: "Overly Broad IP Assignment",
    text: "...whether or not in the course of performing the Services...",
    riskLevel: "high",
    explanation: "This clause assigns ALL intellectual property created during the agreement period to the Company, even work unrelated to the consulting services. This is excessively broad and could capture personal projects, open-source contributions, or work for other clients.",
    suggestedRewrite: "All work product directly related to the Services performed under this Agreement shall be the property of the Company. The Consultant retains all rights to pre-existing IP and work created outside the scope of Services.",
  },
  {
    id: "3",
    title: "Non-Compete Duration & Geography",
    text: "...period of 24 months...India, Southeast Asia, or the Middle East.",
    riskLevel: "high",
    explanation: "A 24-month non-compete spanning three geographic regions is excessively restrictive. Indian courts have historically been skeptical of broad non-compete clauses. Under Section 27 of the Indian Contract Act, 1872, agreements in restraint of trade are generally void.",
    suggestedRewrite: "For a period of 6 months following termination, the Consultant shall not provide identical services to direct competitors of the Company within Bengaluru, Karnataka.",
  },
  {
    id: "4",
    title: "Asymmetric Termination",
    text: "Company may terminate...7 days written notice. Consultant may terminate only upon 90 days...",
    riskLevel: "medium",
    explanation: "The termination clause is heavily one-sided. The Company can terminate with just 7 days notice while the Consultant needs 90 days. This creates an unfair power imbalance and may not withstand judicial scrutiny under Indian contract law principles of fairness.",
    suggestedRewrite: "Either party may terminate this Agreement by providing 30 days written notice to the other party. Upon termination, the Company shall pay for all services rendered through the termination date.",
  },
  {
    id: "5",
    title: "Unlimited Indemnification",
    text: "...indemnify and hold harmless...regardless of fault.",
    riskLevel: "high",
    explanation: "This clause requires the Consultant to indemnify the Company for ALL claims 'regardless of fault,' which means even if the Company is negligent, the Consultant bears the liability. This is fundamentally unfair and potentially unenforceable.",
    suggestedRewrite: "The Consultant agrees to indemnify the Company for claims arising directly from the Consultant's gross negligence or willful misconduct. Total indemnification liability shall not exceed the total fees paid under this Agreement.",
  },
  {
    id: "6",
    title: "Arbitrator Appointment",
    text: "...sole arbitrator appointed by the Company.",
    riskLevel: "medium",
    explanation: "Having the Company unilaterally appoint the arbitrator creates a conflict of interest and may violate the principle of impartiality under the Arbitration and Conciliation Act, 1996. Indian courts have set aside arbitration clauses with such unilateral appointment rights.",
    suggestedRewrite: "The sole arbitrator shall be mutually agreed upon by both parties. If the parties cannot agree within 30 days, the arbitrator shall be appointed by the Karnataka High Court as per the Arbitration and Conciliation Act, 1996.",
  },
];

// Mock analyzed contracts for dashboard
export interface AnalyzedContract {
  id: string;
  name: string;
  date: string;
  riskScore: number;
  clauses: number;
  highRisk: number;
  status: "analyzed" | "pending";
}

export const mockContracts: AnalyzedContract[] = [
  {
    id: "1",
    name: "TechVentures Consulting Agreement",
    date: "2026-03-15",
    riskScore: 72,
    clauses: 8,
    highRisk: 4,
    status: "analyzed",
  },
  {
    id: "2",
    name: "CloudSync SaaS License Agreement",
    date: "2026-03-10",
    riskScore: 45,
    clauses: 12,
    highRisk: 1,
    status: "analyzed",
  },
  {
    id: "3",
    name: "DataBridge NDA - Series B",
    date: "2026-03-08",
    riskScore: 28,
    clauses: 5,
    highRisk: 0,
    status: "analyzed",
  },
];

// Demo analysis output steps
export const demoSteps = [
  "Parsing contract structure...",
  "Identifying clause boundaries...",
  "Analyzing risk patterns with Indian legal corpus...",
  "Cross-referencing with Companies Act, 2013...",
  "Checking MSME Act compliance...",
  "Evaluating non-compete enforceability...",
  "Generating risk assessment...",
  "Preparing rewrite suggestions...",
];
