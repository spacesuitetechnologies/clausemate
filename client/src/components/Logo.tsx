export function Logo({ size = 32, dark = false }: { size?: number; dark?: boolean }) {
  return (
    <img
      src="/clausemate/mainlogo.png"
      alt="Clausemate"
      style={{ height: size, width: "auto" }}
      className={`object-contain cursor-pointer transition-opacity hover:opacity-90 ${dark ? "brightness-0 invert" : ""}`}
    />
  );
}
