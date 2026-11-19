#!/usr/bin/env bash
# Subida limpa do ambiente de teste DESCARTAVEL (regra 1 da skill `suite-de-testes`).
# Derruba, apaga volume, reconstrói a imagem com o código do repo, sobe, gera chaves
# novas e imprime a linha de export para rodar a suíte.
#
#   scripts/up-test.sh            # sobe do zero na porta 8002
#   PROVA_VS=3.2.0 scripts/up-test.sh
#
# NUNCA aponta para produção: porta, rede e volume são próprios (docker-compose.test.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="${COMPOSE:-/opt/data/.local/bin/docker-compose}"
PROJ="${PROJ:-nexostest}"                       # prefixo do compose => nome dos containers
PORTA="${PORTA:-8002}"
BIND="${BIND:-172.28.0.1}"                        # gateway da rede própria (fixa no compose); NUNCA 0.0.0.0 — publicada, a internet lia o /health dos testes (T059)
ENV_FILE="${ENV_FILE:-/opt/data/cache/scratch/nexos_test_keys.env}"

# a versão esperada vem do código (src/config.ts), não de chute
VERSAO="${PROVA_VS:-$(grep -oE 'versao: "[^"]+"' src/config.ts | sed 's/.*"\(.*\)"/\1/')}"
[ -n "$VERSAO" ] || { echo "FALHOU: não achei a versão em src/config.ts"; exit 1; }

gerar_key() { python3 -c 'import secrets; print("nx_" + secrets.token_urlsafe(24).rstrip("="))'; }

echo "== abaixo o ambiente anterior ($PROJ) =="
$COMPOSE -p "$PROJ" -f docker-compose.test.yml down -v --remove-orphans >/dev/null 2>&1 || true

echo "== build da imagem com o código atual do repo =="
$COMPOSE -p "$PROJ" -f docker-compose.test.yml build nexos

echo "== subida (volume novo, banco zerado) =="
USUARIO_KEY="$(gerar_key)"   # nome OBRIGATORIAMENTE "teste": a suíte.assert nos blocos v1.8/MCP/v2.7
#                                      compara tenant === "teste" (trocar o nome quebra 10 checagens)
OPERADOR_KEY="$(gerar_key)"  # papel operador: gestão de usuários/config
NEXOS_USERS="teste:$USUARIO_KEY" \
NEXOS_ADMIN="op:$OPERADOR_KEY" \
NEXOS_TEST_BIND="$BIND" NEXOS_TEST_PORT="$PORTA" \
$COMPOSE -p "$PROJ" -f docker-compose.test.yml up -d

API="${PROJ}-nexos-1"
DB="${PROJ}-nexos-db-1"

# no Hermes a suíte roda DENTRO de um container: BASE = IP da ponte da rede do compose.
# Cuidado: `ip` não existe em todo container e a rede muda de subnome a cada `down -v`,
# então o gateway é lido do próprio docker (e nada aqui pode derrubar o script).
REDE="${PROJ}_default"
BRIDGE="$(docker network inspect "$REDE" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
[ -n "$BRIDGE" ] || BRIDGE="$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
[ -n "$BRIDGE" ] || { echo "FALHOU: não achei o gateway da rede $REDE nem da bridge padrão"; exit 1; }
BASE="http://${BRIDGE}:${PORTA}"

echo "== espera /health =="
ok=""
for _ in $(seq 1 40); do
  sleep 3
  if curl -sf --max-time 5 "$BASE/health" >/dev/null; then ok=1; break; fi
done
[ -n "$ok" ] || { echo "FALHOU: api não respondeu em $BASE/health"; $COMPOSE -p "$PROJ" -f docker-compose.test.yml logs --tail 40 nexos; exit 1; }
curl -s "$BASE/health" | head -c 200; echo

mkdir -p "$(dirname "$ENV_FILE")"
umask 077
cat > "$ENV_FILE" <<EOF
export TESTKEY=$USUARIO_KEY
export OPKEY=$OPERADOR_KEY
export BASE=$BASE
export CONTAINER=$API
export DBCONTAINER=$DB
export VERSAO=$VERSAO
EOF

# quando o script é RODEADO (`source scripts/up-test.sh`), as variáveis já valem no shell
export TESTKEY="$USUARIO_KEY" OPKEY="$OPERADOR_KEY" BASE="$BASE" CONTAINER="$API" DBCONTAINER="$DB" VERSAO="$VERSAO"

echo "== pronto =="
cat <<EOF
set -a; . $ENV_FILE; set +a
SO_BLOCOS="v3.2" npm test        # só os blocos afetados (antes do commit)
npm test                          # suíte completa (antes do push)
# CONTAINER é obrigatória: sem ela os blocos que sobem provedor falso dentro do
# container marcam 1 check em 2ms e ficam VERDES SEM RODAR NADA.
EOF
