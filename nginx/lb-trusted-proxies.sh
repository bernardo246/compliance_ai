#!/bin/sh
# Roda na inicialização do container Nginx (/docker-entrypoint.d/). Gera a lista de proxies em quem
# confiar para descobrir o IP REAL do cliente (módulo real_ip) a partir de LB_TRUSTED_CIDRS
# (faixas do load balancer do provedor, separadas por vírgula).
#
# Falha fechada de propósito: sem a variável, o Nginx NÃO sobe. Sem ela o IP visto pelo backend seria o
# do load balancer (rate limit e auditoria contariam todos os usuários como um só); e confiar em
# qualquer origem deixaria qualquer um forjar o IP com um cabeçalho X-Forwarded-For.
set -eu
set -f

if [ -z "${LB_TRUSTED_CIDRS:-}" ]; then
  echo "ERRO: defina LB_TRUSTED_CIDRS (faixas de IP do load balancer, separadas por vírgula)." >&2
  exit 1
fi

out=/etc/nginx/conf.d/00-trusted-proxies.conf
: > "$out"
old_ifs=$IFS
IFS=','
for faixa in $LB_TRUSTED_CIDRS; do
  faixa=$(printf '%s' "$faixa" | tr -d ' ')
  [ -n "$faixa" ] || continue
  # só IP ou IP/máscara: nada de ';' ou texto que injete diretivas no Nginx
  if ! printf '%s' "$faixa" | grep -Eq '^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$'; then
    echo "ERRO: faixa inválida em LB_TRUSTED_CIDRS: '$faixa'" >&2
    exit 1
  fi
  echo "set_real_ip_from $faixa;" >> "$out"
done
IFS=$old_ifs

if [ ! -s "$out" ]; then
  echo "ERRO: LB_TRUSTED_CIDRS não tem nenhuma faixa válida." >&2
  exit 1
fi
echo "lb-trusted-proxies: confiando no IP do cliente informado por: $(sed 's/set_real_ip_from //; s/;//' "$out" | tr '\n' ' ')"
