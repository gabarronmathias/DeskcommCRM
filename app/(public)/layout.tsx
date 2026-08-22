export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#001124]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 14%, rgba(201,168,102,0.10), transparent 30%), radial-gradient(circle at 50% 100%, rgba(0,30,62,0.72), transparent 48%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#c9a866]/55 to-transparent"
      />

      <div className="relative flex min-h-screen items-center justify-center p-5 sm:p-8">
        <div className="w-full max-w-lg rounded-[30px] border border-white/[0.09] bg-[#001124]/90 p-7 shadow-[0_34px_110px_rgba(0,0,0,0.48)] backdrop-blur-xl sm:p-10">
          {children}
        </div>
      </div>
    </div>
  );
}
