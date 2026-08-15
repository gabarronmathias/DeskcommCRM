"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  newCount: number;
};

export default function OrderAlert({ newCount }: Props) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);

  const playBeep = useCallback(() => {
    if (!soundEnabled) return;

    const AudioContextClass =
      window.AudioContext ||
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;

    if (!AudioContextClass) return;

    const ctx =
      audioContextRef.current ?? new AudioContextClass();

    audioContextRef.current = ctx;

    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const now = ctx.currentTime;

    const beep = (start: number, frequency: number) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = frequency;

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(
        0.18,
        start + 0.02,
      );
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + 0.22,
      );

      oscillator.connect(gain);
      gain.connect(ctx.destination);

      oscillator.start(start);
      oscillator.stop(start + 0.24);
    };

    beep(now, 880);
    beep(now + 0.32, 1040);
  }, [soundEnabled]);

  async function enableSound() {
    const AudioContextClass =
      window.AudioContext ||
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;

    if (!AudioContextClass) return;

    const ctx =
      audioContextRef.current ?? new AudioContextClass();

    audioContextRef.current = ctx;

    await ctx.resume();

    setSoundEnabled(true);

    const now = ctx.currentTime;

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.frequency.value = 880;

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      0.15,
      now + 0.02,
    );
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + 0.18,
    );

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.2);
  }

  useEffect(() => {
    if (newCount <= 0) {
      document.title = "Pedidos | Deskcomm";
      return;
    }

    let visible = true;

    document.title = `🔔 ${newCount} NOVO${
      newCount > 1 ? "S" : ""
    } PEDIDO${newCount > 1 ? "S" : ""} | Deskcomm`;

    const titleInterval = window.setInterval(() => {
      visible = !visible;

      document.title = visible
        ? `🔔 ${newCount} NOVO${
            newCount > 1 ? "S" : ""
          } PEDIDO${newCount > 1 ? "S" : ""} | Deskcomm`
        : "⚠️ PEDIDO AGUARDANDO | Deskcomm";
    }, 900);

    return () => {
      window.clearInterval(titleInterval);
      document.title = "Pedidos | Deskcomm";
    };
  }, [newCount]);

  useEffect(() => {
    if (newCount <= 0 || !soundEnabled) return;

    playBeep();

    const soundInterval = window.setInterval(() => {
      playBeep();
    }, 4000);

    return () => window.clearInterval(soundInterval);
  }, [newCount, soundEnabled, playBeep]);

  if (newCount <= 0) {
    return (
      <div className="flex items-center justify-end">
        {!soundEnabled ? (
          <button
            type="button"
            onClick={() => void enableSound()}
            className="rounded-lg border bg-background px-3 py-2 text-xs font-semibold hover:bg-muted"
          >
            🔔 Ativar som dos pedidos
          </button>
        ) : (
          <span className="text-xs font-medium text-emerald-600">
            🔊 Alertas sonoros ativos
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="sticky top-0 z-50 rounded-xl border-2 border-red-500 bg-red-50 p-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="animate-pulse text-3xl">
            🔔
          </span>

          <div>
            <div className="text-base font-bold text-red-700">
              {newCount} pedido{newCount > 1 ? "s" : ""} aguardando aceite
            </div>

            <div className="text-sm text-red-600">
              O alerta continuará até todos os pedidos novos
              serem aceitos.
            </div>
          </div>
        </div>

        {!soundEnabled ? (
          <button
            type="button"
            onClick={() => void enableSound()}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
          >
            🔊 Ativar alerta sonoro
          </button>
        ) : (
          <span className="rounded-full bg-red-100 px-3 py-1.5 text-xs font-bold text-red-700">
            🔊 Som ativo
          </span>
        )}
      </div>
    </div>
  );
}
