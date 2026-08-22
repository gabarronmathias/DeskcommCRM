import Image from "next/image";
import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";

export const metadata = { title: "Entrar | Gabarron & Mathias" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string; error?: string }>;
}) {
  const { next, reset, error } = await searchParams;

  return (
    <div className="space-y-7">
      <div className="text-center">
        <div className="relative mx-auto mb-5 flex h-48 w-full items-center justify-center sm:h-52">
          <div
            aria-hidden="true"
            className="absolute h-36 w-72 rounded-full bg-[#c9a866]/10 blur-3xl"
          />
          <Image
            src="/branding/gabarron-mathias-logo.jpg"
            alt="Gabarron & Mathias"
            width={420}
            height={420}
            className="relative z-10 h-48 w-48 object-contain mix-blend-screen contrast-125 saturate-110 sm:h-52 sm:w-52"
            priority
          />
        </div>

        <div className="mx-auto mb-5 h-px w-40 bg-gradient-to-r from-transparent via-[#c9a866]/70 to-transparent" />

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Entrar</h1>
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[#c9a866]">
            Gabarron &amp; Mathias
          </p>
        </div>
      </div>

      {reset === "success" && (
        <div
          className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-sm"
          role="status"
        >
          Senha redefinida com sucesso. Entre com a nova senha.
        </div>
      )}

      {error === "link_invalido" && (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Link inválido ou expirado. Peça um novo em Recuperar senha ou refaça o
          cadastro.
        </div>
      )}

      {error === "convite_invalido" && (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Sua conta foi confirmada, mas o convite não vale mais — ele expirou ou
          foi emitido para outro e-mail. Peça um novo a quem te convidou. Não
          criamos uma empresa nova para você, porque não era isso que você
          estava fazendo.
        </div>
      )}

      {error === "template_padrao" && (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Este link veio do modelo de e-mail padrão do Supabase, que não fecha o
          acesso nesta instalação — pedir outro link não resolve. Quem administra
          o sistema precisa configurar os e-mails de acesso (
          <code>marca-emails.sh</code>, no kit de instalação).
        </div>
      )}

      {error === "provisionamento" && (
        <div
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Sua conta foi confirmada, mas houve um erro ao preparar seu ambiente.
          Tente entrar novamente em instantes.
        </div>
      )}

      <LoginForm next={next} />

      <div className="space-y-2 pt-1 text-center text-sm">
        <p>
          <Link
            href="/login/forgot"
            className="text-white/45 underline decoration-white/20 underline-offset-4 transition-colors hover:text-[#c9a866]"
          >
            Esqueci minha senha
          </Link>
        </p>
        <p className="text-white/40">
          Não tem conta?{" "}
          <Link
            href="/signup"
            className="font-medium text-white/80 underline decoration-white/20 underline-offset-4 transition-colors hover:text-[#c9a866]"
          >
            Criar conta
          </Link>
        </p>
      </div>
    </div>
  );
}
