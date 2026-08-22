export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07090d]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 18%, rgba(201,168,102,0.14), transparent 32%), radial-gradient(circle at 50% 115%, rgba(28,43,59,0.38), transparent 44%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#c9a866]/60 to-transparent"
      />

      <div className="relative flex min-h-screen items-center justify-center p-5 sm:p-8">
        <div className="w-full max-w-md rounded-[28px] border border-white/[0.08] bg-black/35 p-7 shadow-[0_30px_90px_rgba(0,0,0,0.55)] backdrop-blur-xl sm:p-9">
          {children}
        </div>
      </div>
    </div>
  );
}
