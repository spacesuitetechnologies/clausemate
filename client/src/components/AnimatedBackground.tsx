/**
 * AnimatedBackground — wave-style hero background
 *
 * Design: flowing sky-blue energy waves over deep navy-black.
 * Layer anatomy (back → front):
 *   1. Solid base (#02080f)
 *   2. Wave 1 — wide primary sky-blue ellipse, slow horizontal drift (26s)
 *   3. Wave 2 — wider cyan ellipse, counter-phase drift (34s)
 *   4. Wave 3 — diagonal energy band, faster (19s)
 *   5. Glow core — static radial highlight at top-center (light source)
 *   6. Glow pulse — centered breathing radial (6s opacity cycle)
 *   7. Sweep ray — single diagonal light ray, full width traverse (22s)
 *   8. Dot grid — 44px subtle texture (static)
 *   9. Bottom fade — linear gradient to keep lower edge dark
 *
 * All animations use only transform + opacity (GPU compositor layer).
 * No layout or paint triggered on any frame.
 *
 * Usage:
 *   <section className="relative overflow-hidden">
 *     <AnimatedBackground />
 *     <div className="relative z-10">…content…</div>
 *   </section>
 */
export function AnimatedBackground() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden pointer-events-none select-none"
      style={{ zIndex: 0 }}
    >
      {/* ── 1. Base — very dark navy-black ─────────────────────────────── */}
      <div className="absolute inset-0" style={{ background: "#02080f" }} />

      {/* ── 2. Wave 1: primary sky-blue — wide flat ellipse, top band ───── */}
      {/*    Moves left → right → left, slight Y wobble, scaleX breathe.   */}
      {/*    This is the dominant color layer — opacity pushed high.        */}
      <div
        className="ab-wave ab-wave-1 absolute"
        style={{
          width: "160vw",
          height: "58vh",
          top: "-8%",
          left: "-30%",
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at 50% 60%, rgba(14,165,233,0.50) 0%, rgba(2,132,199,0.26) 45%, transparent 72%)",
          filter: "blur(52px)",
          willChange: "transform",
        }}
      />

      {/* ── 3. Wave 2: cyan — wider, lower, counter-phase ───────────────── */}
      {/*    Drifts in opposite direction to wave 1. Where they overlap    */}
      {/*    the combined glow brightens — this creates the wave rhythm.   */}
      <div
        className="ab-wave ab-wave-2 absolute"
        style={{
          width: "180vw",
          height: "72vh",
          top: "22%",
          left: "-40%",
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at 50% 40%, rgba(6,182,212,0.26) 0%, rgba(8,145,178,0.14) 48%, transparent 72%)",
          filter: "blur(80px)",
          willChange: "transform",
        }}
      />

      {/* ── 4. Wave 3: diagonal energy band ────────────────────────────── */}
      {/*    Lighter sky-blue, narrower, moves diagonally. Acts as the    */}
      {/*    "crest" shimmer visible between the two main wave troughs.   */}
      <div
        className="ab-wave ab-wave-3 absolute"
        style={{
          width: "120vw",
          height: "42vh",
          top: "46%",
          left: "-10%",
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(56,189,248,0.20) 0%, rgba(14,165,233,0.10) 50%, transparent 72%)",
          filter: "blur(60px)",
          willChange: "transform",
        }}
      />

      {/* ── 5. Glow core — static radial, top-center ─────────────────────  */}
      {/*    Fixed "light source" — gives the scene a sense of origin.     */}
      {/*    Not animated, so it always anchors the scene.                 */}
      <div
        className="absolute"
        style={{
          width: "60vw",
          height: "50vh",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(56,189,248,0.22) 0%, rgba(14,165,233,0.10) 50%, transparent 72%)",
          filter: "blur(40px)",
        }}
      />

      {/* ── 6. Glow pulse — breathing central highlight ───────────────── */}
      {/*    Slowly swells and recedes in opacity. Creates the impression  */}
      {/*    that light is flowing through the scene rhythmically.         */}
      <div
        className="ab-glow-pulse absolute"
        style={{
          width: "80vw",
          height: "60vh",
          top: "5%",
          left: "50%",
          transform: "translateX(-50%)",
          background:
            "radial-gradient(ellipse at 50% 30%, rgba(14,165,233,0.18) 0%, rgba(2,132,199,0.08) 55%, transparent 78%)",
          filter: "blur(64px)",
          willChange: "opacity, transform",
        }}
      />

      {/* ── 7. Sweep ray — diagonal light streak, full-width traverse ───── */}
      {/*    A single thin light ray that crosses the hero every 22s.      */}
      {/*    Fades in from left, fades out at right — never visible at     */}
      {/*    rest so there is no "reset flash".                            */}
      <div
        className="ab-sweep absolute"
        style={{
          width: "200%",
          height: "2px",
          top: "38%",
          left: "-50%",
          background:
            "linear-gradient(90deg, transparent 0%, rgba(125,211,252,0.08) 15%, rgba(56,189,248,0.40) 50%, rgba(125,211,252,0.08) 85%, transparent 100%)",
          filter: "blur(3px)",
          willChange: "transform, opacity",
        }}
      />

      {/* ── 8. Dot grid — 44px grid, sky-tinted dots ────────────────────── */}
      {/*    Very low opacity. Adds the premium "structured depth" found   */}
      {/*    in Stripe / Linear hero sections.                             */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(125,211,252,0.60) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          opacity: 0.032,
        }}
      />

      {/* ── 9. Bottom fade — darkens lower hero so text sits on dark bg ─── */}
      <div
        className="absolute inset-x-0 bottom-0"
        style={{
          height: "35%",
          background:
            "linear-gradient(to bottom, transparent 0%, rgba(2,8,15,0.70) 100%)",
        }}
      />
    </div>
  );
}
