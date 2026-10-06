// Intervalo do polling de status enquanto um documento está em análise.
//
// Cada consulta custa de 2 a 3 leituras no banco e, com muitos usuários
// esperando ao mesmo tempo, o polling é o que mais pesa nele. A análise leva de
// dezenas de segundos a alguns minutos, então o intervalo começa curto (a
// resposta aparece rápido quando a análise é rápida) e cresce quanto mais
// demora: 4 s nas 5 primeiras consultas (~20 s), 8 s nas 5 seguintes (~1 min)
// e 15 s depois. Com a aba oculta ninguém está olhando: 30 s.
export function pollDelayMs(attempt: number, hidden = false): number {
  if (hidden) return 30_000;
  if (attempt < 5) return 4_000;
  if (attempt < 10) return 8_000;
  return 15_000;
}
