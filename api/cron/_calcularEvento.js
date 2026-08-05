'use strict';

/**
 * Determina o evento de lembrete para uma parcela dado o número de dias até o vencimento.
 *
 * @param {number} dias  Inteiro. Positivo = vencimento no futuro. Negativo = atraso.
 *                       Calculado como: (vencimento - CURRENT_DATE) no PostgreSQL.
 * @returns {'D-3'|'D+1'|'D+7'|'D+15'|null}
 *
 * Faixas (else-if encadeado — sem sobreposição, falha visível se faixas mudarem):
 *   D-3  : dias ∈ [1, 3]    — vencimento próximo; ainda dá para evitar o atraso
 *   D+1  : dias ∈ [-6, -1]  — recém-vencido; primeiro contato
 *   D+7  : dias ∈ [-14, -7] — segundo contato
 *   D+15 : dias ≤ -15        — encaminhar para tratamento humano; sem e-mail
 *   null : dias > 3           — muito cedo; aguardar
 *          dias = 0           — dia do vencimento: D-3 já foi, D+1 começa amanhã;
 *                               enviar no próprio dia seria tarde para agir e vira ruído
 */
function calcularEvento(dias) {
  if      (dias >= 1  && dias <= 3)   return 'D-3';
  else if (dias >= -6 && dias <= -1)  return 'D+1';
  else if (dias >= -14 && dias <= -7) return 'D+7';
  else if (dias <= -15)               return 'D+15';
  else                                return null;
}

module.exports = { calcularEvento };
