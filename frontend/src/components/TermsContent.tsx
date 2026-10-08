'use client';

// Texto do Termo de Uso e da Política de Privacidade. Fica num componente só para ser exibido
// na tela de aceite (/termos, depois do cadastro) e na página pública (/privacidade, antes).
//
// ATENÇÃO: este texto descreve o que o sistema FAZ hoje (ver README, "Fase 10"). É um rascunho
// técnico fiel ao código, mas NÃO substitui a revisão de um advogado. Ao mudar o conteúdo de
// forma relevante, aumente TERMS_CURRENT_VERSION (backend) e NEXT_PUBLIC_TERMS_VERSION
// (frontend): isso obriga todos os usuários a aceitarem de novo.

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';

const CONTROLLER = process.env.NEXT_PUBLIC_CONTROLLER_NAME?.trim();
const CONTACT = process.env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold text-textPrimary">{titulo}</h2>
      {children}
    </section>
  );
}

/**
 * O provedor de IA pode usar o conteúdo para treino? Vem do backend (GET /api/privacy-info), que é
 * quem sabe com que configuração está rodando: o texto nunca promete o que o sistema não cumpre.
 * Se a consulta falhar, assume o pior caso (treino permitido) e avisa; enquanto carrega, é null.
 */
function useTreinoPermitido(): boolean | null {
  const [treino, setTreino] = useState<boolean | null>(null);
  useEffect(() => {
    let vivo = true;
    fetch(`${API_URL}/api/privacy-info`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => vivo && setTreino(d.ia_treino_permitido !== false))
      .catch(() => vivo && setTreino(true));
    return () => {
      vivo = false;
    };
  }, []);
  return treino;
}

export function TermsContent({ onCarregado }: { onCarregado?: () => void }) {
  const treino = useTreinoPermitido();
  useEffect(() => {
    if (treino !== null) onCarregado?.();
  }, [treino, onCarregado]);

  return (
    <div className="space-y-6 text-sm leading-relaxed text-textSecondary">
      <Secao titulo="1. Quem é o responsável pelos seus dados">
        {CONTROLLER && CONTACT ? (
          <p>
            O controlador dos dados pessoais tratados nesta plataforma é <strong>{CONTROLLER}</strong>.
            Para exercer seus direitos ou tirar dúvidas sobre privacidade, escreva para{' '}
            <a className="text-brand hover:text-brandHover" href={`mailto:${CONTACT}`}>
              {CONTACT}
            </a>
            .
          </p>
        ) : (
          <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-yellow-300">
            Os dados do responsável pela plataforma e o canal de contato de privacidade ainda não
            foram configurados (NEXT_PUBLIC_CONTROLLER_NAME e NEXT_PUBLIC_PRIVACY_EMAIL).
          </p>
        )}
      </Secao>

      <Secao titulo="2. O que a plataforma faz">
        <p>
          Você envia documentos (PDF, CSV ou Excel) e escolhe uma área de negócio. O conteúdo é
          analisado por inteligência artificial, que gera um resumo, pontos de compliance e sugestões
          de melhoria para aquela área. A análise é automatizada, pode conter erros ou omissões e{' '}
          <strong>não substitui parecer jurídico, contábil ou de outro profissional</strong>.
        </p>
      </Secao>

      <Secao titulo="3. Quais dados tratamos">
        <ul className="list-disc space-y-1 pl-5">
          <li>Conta: e-mail e senha (a senha é guardada apenas como hash, nunca em texto).</li>
          <li>Os arquivos que você envia e o texto extraído deles para a análise.</li>
          <li>O resultado da análise gerado para cada documento.</li>
          <li>
            Registros de auditoria: ações como login, envio e exclusão de documentos, com data e
            endereço IP, e o registro do seu aceite deste termo (versão e data).
          </li>
        </ul>
      </Secao>

      <Secao titulo="4. Com quem os dados são compartilhados">
        <p>Usamos prestadores de serviço (operadores) para funcionar:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Provedor de IA (via OpenRouter):</strong> o texto extraído do seu documento é
            enviado a um modelo de linguagem de terceiros para gerar a análise (não enviamos o arquivo
            original, apenas o texto).{' '}
            {treino === null ? (
              'Carregando a informação sobre o tratamento feito pelo provedor...'
            ) : treino ? (
              <strong className="text-yellow-300">
                Atenção: para manter o serviço gratuito usamos modelos de IA gratuitos, cujos provedores
                podem guardar o texto enviado e usá-lo para treinar seus modelos. Não envie documentos
                confidenciais ou com dados pessoais que você não aceite expor a esse tratamento.
              </strong>
            ) : (
              'Configuramos a chamada para usar apenas provedores que não guardam nem usam o conteúdo para treinar modelos.'
            )}
          </li>
          <li>
            <strong>Supabase:</strong> banco de dados e armazenamento dos arquivos.
          </li>
        </ul>
        <p>Não vendemos seus dados nem os usamos para publicidade.</p>
      </Secao>

      <Secao titulo="5. Por quanto tempo guardamos">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Arquivo original:</strong> apagado automaticamente em até 72 horas após o envio,
            ou antes, se você excluir o documento.
          </li>
          <li>
            <strong>Resultado da análise:</strong> continua associado à sua conta, mesmo depois que o
            arquivo original é apagado, até você pedir a eliminação.
          </li>
          <li>
            <strong>Conta e registros de auditoria:</strong> mantidos enquanto a conta existir e pelo
            prazo necessário para segurança e obrigações legais.
          </li>
        </ul>
      </Secao>

      <Secao titulo="6. Seus direitos (LGPD)">
        <p>
          Você pode pedir confirmação de que tratamos seus dados, acesso, correção, anonimização ou
          eliminação, portabilidade, informação sobre com quem compartilhamos e a revogação do
          consentimento. Os pedidos são feitos pelo contato indicado na seção 1.
        </p>
      </Secao>

      <Secao titulo="7. Segurança">
        <p>
          Aplicamos controle de acesso (cada usuário só enxerga os próprios documentos), limites de
          tentativas contra abuso, verificação básica dos arquivos enviados e registro de ações
          sensíveis. Nenhum sistema é totalmente imune a falhas; em caso de incidente relevante,
          comunicaremos os afetados conforme a lei.
        </p>
      </Secao>

      <Secao titulo="8. Suas responsabilidades">
        <p>
          Você declara ter autorização legal para enviar os documentos e deve evitar enviar dados
          pessoais ou sigilosos de terceiros sem uma base legal que permita o tratamento. Não use a
          plataforma para fins ilícitos nem tente burlar seus limites ou proteções.
        </p>
      </Secao>

      <Secao titulo="9. Mudanças neste texto">
        <p>
          Quando este texto mudar de forma relevante, a versão será atualizada e pediremos um novo
          aceite antes de você continuar usando a plataforma.
        </p>
      </Secao>
    </div>
  );
}
