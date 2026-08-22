export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-y-auto bg-[#041232]">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 8%, rgba(25,58,116,0.46), transparent 38%), linear-gradient(180deg, #071a42 0%, #041232 48%, #03102c 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#c9a866]/55 to-transparent"
      />

      <div className="relative flex min-h-screen items-center justify-center px-4 py-4 sm:px-6 sm:py-5">
        <div className="w-full max-w-md rounded-[26px] border border-white/[0.09] bg-[#06183b]/74 p-5 shadow-[0_28px_85px_rgba(0,0,0,0.30)] backdrop-blur-xl sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
