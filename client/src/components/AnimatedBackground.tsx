/**
 * AnimatedBackground
 *
 * Full-bleed animated hero background — sky blue / black palette.
 * GPU-only animations (transform + opacity). No JS timers.
 *
 * Usage:
 *   <section className="relative min-h-screen">
 *     <AnimatedBackground />
 *     <div className="relative z-10">…content…</div>
 *   </section>
 *
 * The parent must have `position: relative` (or absolute/fixed).
 * Content must have `position: relative` + a z-index above 0.
 */
export function AnimatedBackground() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden pointer-events-none select-none"
      style={{ zIndex: 0 }}
    >
      {/* ── Base fill — very dark navy-black ──────────────────────────── */}
      <div className="absolute inset-0" style={{ background: "#030d1a" }} />

      {/* ── Layer 1: Primary sky-blue blob — top-left, drifts diagonally ── */}
      <div
        className="ab-blob ab-blob-1 absolute rounded-full"
        style={{
          width: "75vw",
          height: "75vw",
          maxWidth: 860,
          maxHeight: 860,
          top: "-18%",
          left: "-12%",
          background:
            "radial-gradient(circle at 50% 50%, rgba(14,165,233,0.28) 0%, rgba(2,132,199,0.14) 38%, transparent 68%)",
          filter: "blur(72px)",
          willChange: "transform",
        }}
      />

      {/* ── Layer 2: Cyan accent blob — bottom-right, counter-drift ───── */}
      <div
        className="ab-blob ab-blob-2 absolute rounded-full"
        style={{
          width: "62vw",
          height: "62vw",
          maxWidth: 720,
          maxHeight: 720,
          bottom: "-14%",
          right: "-8%",
          background:
            "radial-gradient(circle at 50% 50%, rgba(6,182,212,0.22) 0%, rgba(8,145,178,0.11) 42%, transparent 68%)",
          filter: "blur(88px)",
          willChange: "transform",
        }}
      />

      {/* ── Layer 3: Mid-tone sky blob — center, vertical float ────────── */}
      <div
        className="ab-blob ab-blob-3 absolute rounded-full"
        style={{
          width: "48vw",
          height: "48vw",
          maxWidth: 580,
          maxHeight: 580,
          top: "28%",
          left: "32%",
          background:
            "radial-gradient(circle at 50% 50%, rgba(56,189,248,0.13) 0%, rgba(14,116,144,0.07) 50%, transparent 72%)",
          filter: "blur(100px)",
          willChange: "transform",
        }}
      />

      {/* ── Static glow: soft radial — top-center (premium highlight) ─── */}
      <div
        className="absolute"
        style={{
          width: "55vw",
          height: "45vh",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(56,189,248,0.14) 0%, transparent 65%)",
          filter: "blur(48px)",
        }}
      />

      {/* ── Static glow: deep blue — bottom-left corner ──────────────── */}
      <div
        className="absolute"
        style={{
          width: "40vw",
          height: "38vh",
          bottom: 0,
          left: 0,
          background:
            "radial-gradient(ellipse at 0% 100%, rgba(2,132,199,0.16) 0%, transparent 60%)",
          filter: "blur(56px)",
        }}
      />

      {/* ── Light streak 1: diagonal, slow sweep ──────────────────────── */}
      <div
        className="ab-streak ab-streak-1 absolute"
        style={{
          width: "130%",
          height: "1px",
          top: "34%",
          left: "-15%",
          background:
            "linear-gradient(90deg, transparent 0%, rgba(125,211,252,0.10) 20%, rgba(56,189,248,0.30) 50%, rgba(125,211,252,0.10) 80%, transparent 100%)",
          filter: "blur(2px)",
          transform: "rotate(-11deg)",
          willChange: "transform, opacity",
        }}
      />

      {/* ── Light streak 2: shallower angle, delayed ─────────────────── */}
      <div
        className="ab-streak ab-streak-2 absolute"
        style={{
          width: "110%",
          height: "1px",
          top: "62%",
          left: "-5%",
          background:
            "linear-gradient(90deg, transparent 0%, rgba(6,182,212,0.08) 25%, rgba(34,211,238,0.22) 50%, rgba(6,182,212,0.08) 75%, transparent 100%)",
          filter: "blur(1.5px)",
          transform: "rotate(-6deg)",
          willChange: "transform, opacity",
        }}
      />

      {/* ── Dot grid texture — depth & premium grid feel ──────────────── */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(125,211,252,0.55) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          opacity: 0.028,
        }}
      />

      {/* ── Edge vignette — keeps content readable ────────────────────── */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 100% 100% at 50% 50%, transparent 40%, rgba(3,13,26,0.55) 100%)",
        }}
      />
    </div>
  );
}
