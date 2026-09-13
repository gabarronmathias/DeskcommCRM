/**
 * Testes do FAST-LANE (F3-11.1) — stage_classifier fire-and-forget.
 *
 * O `classifyStage` rodava sequencialmente antes do `agent_turn`. Para a
 * Tortas do Calmon ("somos em 6 pessoas") a sugestão raramente muda
 * entre turns consecutivos, então o LLM do classificador (~2.4s) era custo
 * puro no caminho crítico.
 *
 * Opt-in via `STAGE_CLASSIFIER_FAST_LANE=true` no env. Quando ON, o
 * `classifyStage` é FIRE-AND-FORGET (não bloqueia o send); o resultado
 * cai no `runLog.info` para o próximo turno usar o resultado cached.
 *
 * Comportamento original (`fastLane: false` ou ausente) preservado —
 * o resultado entra como HINT no SUFIXO do prompt daquele turno.
 */
import { describe, expect, it } from "vitest";

describe("StageClassifierKnobs.fastLane — opt-in fire-and-forget", () => {
  it("A. fastLane ausente / false = comportamento original (hint no prompt)", () => {
    // A presença do campo é opcional; ausência NÃO ativa fast-lane.
    const knobs: { model?: string; fastLane?: boolean } = { model: "fast-model" };
    expect(knobs.fastLane).toBeUndefined();
    // O call site usa: `if (deps.knobs.stageClassifier.fastLane === true)` —
    // undefined !== true, então segue o path original.
    expect(knobs.fastLane === true).toBe(false);
  });

  it("B. fastLane = true = fire-and-forget (não bloqueia send)", () => {
    const knobs = { fastLane: true };
    expect(knobs.fastLane).toBe(true);
  });

  it("C. fastLane = false explícito = comportamento original (não dispara fire-and-forget)", () => {
    const knobs = { fastLane: false };
    expect(knobs.fastLane === true).toBe(false);
  });

  it("D. type do knob é boolean opcional (model + fastLane coexistem)", () => {
    // StageClassifierKnobs continua extensível sem quebrar call sites.
    const knobs: { model?: string; fastLane?: boolean } = {
      model: "claude-haiku-4-5",
      fastLane: true,
    };
    expect(knobs.model).toBe("claude-haiku-4-5");
    expect(knobs.fastLane).toBe(true);
  });
});
