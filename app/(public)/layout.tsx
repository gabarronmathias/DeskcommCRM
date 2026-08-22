export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#071435]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 10%, rgba(15,40,86,0.72), transparent 36%), linear-gradient(180deg, #0A193B 0%, #071435 42%, #071435 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#c9a866]/60 to-transparent"
      />

      <div className="relative flex min-h-screen items-center justify-center p-5 sm:p-8">
        <div className="w-full max-w-lg rounded-[30px] border border-white/[0.09] bg-[#071435]/96 p-7 shadow-[0_34px_110px_rgba(0,0,0,0.30)] backdrop-blur-xl sm:p-10">
          {children}
        </div>
      </div>
    </div>
  );
}
