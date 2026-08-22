import Image from "next/image";
import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { GM_LOGIN_LOGO_DATA_URI } from "@/lib/branding/login-logo";

export const metadata = { title: "Entrar | Gabarron & Mathias" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string; error?: string }>;
}) {
  const { next, reset, error } = await searchParams;

  return (
    <div className="space-y-5">
      <div className="text-center">
        <div className="relative mx-auto mb-3 flex h-[200px] w-full items-center justify-center sm:h-[215px]">
          <div
            aria-hidden="true"
            className="absolute h-32 w-56 rounded-full bg-[#c9a866]/10 blur-3xl"
          />
          <Image
            src={GM_LOGIN_LOGO_DATA_URI}
            alt="Gabarron & Mathias"
            width={512}
            height={512}
            className="relative z-10 h-[195px] w-[195px] object-contain sm:h-[210px] sm:w-[210px]"
            priority
            unoptimized
            draggable={false}
          />
        </div>

        <div className="mx-auto mb-3 h-px w-36 bg-gradient-to-r from-transparent via-[#c9a866]/75 to-transparent" />

        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Entrar</h1>
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-[#c9a866]">
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

      <div className="flex items-center justify-center gap-3 pt-0.5 text-xs sm:text-sm">
        <Link
          href="/login/forgot"
          className="text-white/55 underline decoration-white/20 underline-offset-4 transition-colors hover:text-[#c9a866]"
        >
          Esqueci minha senha
        </Link>
        <span aria-hidden="true" className="h-3 w-px bg-[#c9a866]/35" />
        <Link
          href="/signup"
          className="font-medium text-[#c9a866]/90 underline decoration-[#c9a866]/25 underline-offset-4 transition-colors hover:text-[#dfbd78]"
        >
          Criar conta
        </Link>
      </div>
    </div>
  );
}
