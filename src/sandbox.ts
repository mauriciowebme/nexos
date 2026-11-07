/**
 * T052 — Sandbox Python por usuário.
 *
 * Cada usuário tem a SUA pasta, dentro do mesmo volume que guarda os arquivos dele:
 *
 *   /app/dados/usuarios/<tenant>/
 *     venv/                  caixa de bibliotecas só dele (criada na primeira execução)
 *     scripts/ferramentas/   scripts salvos (etapa 2 da tarefa)
 *     scripts/saida/         arquivos que os scripts geram (fica entre execuções)
 *     dependencias.txt       o que já foi instalado, com data — a lista de compras
 *     pip-cache/             download guardado; não baixa duas vezes
 *
 * A ponte com as ferramentas do nexos (sem rede, sem token, sem HTTP):
 *
 *   pai (Node)                          filho (python)
 *   ----------                          --------------
 *   stdin  ─────── resposta JSON ─────▶  sys.stdin
 *   fd 3   ◀───── pedido  JSON ────────  os.fdopen(3, "w")
 *   stdout ◀───── print do script ─────  print()
 *
 * O script importa o módulo `nexos` (gerado em cada execução) e chama
 * `nexos.web_search(query="...")`. Cada chamada vira uma linha JSON no fd 3; o Node executa
 * `chamarToolInterna`, que é o MESMO caminho do POST /mcp e checa a permissão do usuário que
 * pediu — o script nunca ganha poder que o usuário não tem.
 *
 * Bibliotecas: o script DECLARA o que precisa (`dependencias`) e o servidor instala só o que
 * falta, no venv daquele usuário. `pip` é o único processo com rede liberada; o script roda
 * com a rede fechada e alcança a internet só pelas ferramentas.
 */
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, chmod, chown, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { Usuario } from "./config";
import { log } from "./config";
import { criarAnexo, type AnexoMeta } from "./anexos";
import { subirProxy, type DestinoProxy } from "./sandbox_proxy";

const rodar = promisify(execFile);

/** Raiz das pastas por usuário (mesmo volume dos anexos). */
const RAIZ = process.env.NEXOS_SCRIPTS_DIR ?? "/app/dados/usuarios";
/** Teto de disco por usuário (bibliotecas + scripts + saídas). */
const TETO_MB = Number(process.env.NEXOS_SANDBOX_TETO_MB ?? 2048);
/** Teto de saída devolvida ao modelo (o resto é cortado e sinalizado). */
const TETO_SAIDA = 120_000;
/** Tempo máximo de uma execução. */
const TETO_SEG = 120;
/** Teto de memória do processo Python (endereço virtual). */
const TETO_MEM_MB = Number(process.env.NEXOS_SANDBOX_MEM_MB ?? 512);
/** Teto do arquivo que o script entrega na conversa por `nexos.anexar` (vai lido em memória). */
const TETO_ANEXO_PY = 64 * 1024 * 1024;

export type ChamadaFerramenta = { ferramenta: string; ok: boolean; ms: number };

export type ResultadoPython = {
  ok: boolean;
  codigo: number | null;
  saida: string;
  erro: string;
  truncado: boolean;
  ms: number;
  chamadas: ChamadaFerramenta[];
  /** Destinos que passaram (ou foram recusados) pelo proxy de saída. */
  rede: DestinoProxy[];
  instalados: string[];
  pasta: string;
  uso_mb: number;
  /** v3.67 — primeiro arquivo entregue por `nexos.anexar(...)`: vai para a bolha como anexo. */
  anexo?: AnexoMeta;
  /** todos os arquivos anexados neste script (o chat mostra o primeiro; os demais ficam registrados) */
  anexos?: AnexoMeta[];
};

const escapar = (s: string): string => JSON.stringify(s);

/** Nome de pasta seguro a partir do tenant. */
function pastaDe(tenant: string): string {
  const t = String(tenant ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return t || "_";
}

/** Gera o `nexos.py` da execução: só as ferramentas que ESTE usuário pode chamar. */
export function moduloPonte(nomes: string[], descricoes: Record<string, string>): string {
  const funcoes = nomes
    .map((n) => {
      const doc = (descricoes[n] ?? "").replace(/"""/g, "'''").slice(0, 200);
      return `def ${n}(**kwargs):\n    """${doc}"""\n    return _chamar(${escapar(n)}, **kwargs)\n`;
    })
    .join("\n");
  return `"""Ponte gerada pelo nexos (T052) — as ferramentas do servidor como funções Python.

Cada função recebe os mesmos parâmetros da ferramenta e devolve o resultado em Python
(dict, lista, texto ou numero). Em caso de recusa ou erro, levanta RuntimeError.
Nao use 'import requests' nem sockets para falar com a internet: use estas funcoes.
"""

import json as _json
import os as _os
import sys as _sys

_pedidos = _os.fdopen(3, "w", buffering=1, encoding="utf-8")
_respostas = _sys.stdin


def _chamar(_tool, **args):
    _pedidos.write(_json.dumps({"tool": _tool, "args": args}, ensure_ascii=False) + "\\n")
    _pedidos.flush()
    linha = _respostas.readline()
    if not linha:
        raise RuntimeError("a ponte com o nexos caiu (o servidor encerrou a execucao)")
    r = _json.loads(linha)
    if not r.get("ok"):
        raise RuntimeError(r.get("erro") or ("falha em " + _tool))
    return r.get("resultado")


def anexar(caminho):
    """Entrega ao usuario um arquivo que o script criou (ex: "scripts/saida/planilha.xlsx").
    O arquivo aparece na conversa como anexo baixavel; use depois enviar_para_maquina se
    a pessoa pedir para mandar para uma maquina. Devolve {"id","nome","bytes"}."""
    return _chamar("__anexar", caminho=str(caminho))


def ferramentas():
    """Lista os nomes das ferramentas disponiveis nesta execucao."""
    return [${nomes.map(escapar).join(", ")}]


${funcoes}`;
}

/** Gera o `sitecustomize.py`.
 *
 *  v3.63 — o cadeado saiu do gancho de `ctypes` e foi para o KERNEL:
 *  Landlock limita o disco à pasta da conta (leitura do sistema, escrita só nas pastas dele)
 *  e seccomp recusa rede, exec e troca de namespace. Assim numpy/pandas/openpyxl, que usam
 *  `ctypes` para carregar biblioteca nativa na importação, voltam a funcionar sem reabrir
 *  a rede: quem barra o `socket` agora é o kernel, não o Python.
 *
 *  Os ganchos de `socket`/processo continuam, para a mensagem amigável e para o proxy.
 */
function moduloRede(porta: number, escreve: string[], le: string[]): string {
  const lista = (v: string[]) => JSON.stringify(v);
  return `"""Rede, processos e disco do sandbox (T053, v3.63).

- Rede: so pelo proxy local (127.0.0.1:${porta}); o kernel tambem recusa socket/connect.
- Processo: subprocess/os.system/exec e troca de namespace sao recusados.
- Disco (Landlock): leitura do sistema; escrita so em ${escreve.join(", ")}.
- ctypes e permitido: sem ele numpy/pandas/openpyxl nao importam.
"""
import errno as _errno
import os as _os
import sys as _sys

_PORTA = ${porta}
_ESCREVE = ${lista(escreve)}
_LE = ${lista(le)}


def _avisar(msg):
    try:
        _sys.stderr.write("[sandbox] " + msg + "\\n")
    except Exception:
        pass


def _no_new_privs():
    import ctypes

    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS")


def _landlock():
    """Restringe o disco: escrita nas pastas da conta, leitura no sistema."""
    import ctypes

    libc = ctypes.CDLL("libc.so.6", use_errno=True)

    class Ruleset(ctypes.Structure):
        _fields_ = [
            ("handled_access_fs", ctypes.c_uint64),
            ("handled_access_net", ctypes.c_uint64),
            ("scoped", ctypes.c_uint64),
        ]

    class Regra(ctypes.Structure):
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    EXEC, WRITE, READ, READDIR = 1, 2, 4, 8
    RMDIR, RMFILE, MKDIR, MKREG = 16, 32, 128, 256
    MKSYM, REFER, TRUNC = 4096, 8192, 16384
    TUDO = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512 | 1024 | 2048 | 4096
    TUDO |= REFER | TRUNC
    RO = EXEC | READ | READDIR
    RW = TUDO & ~64 & ~2048 & ~512  # sem criar dispositivo nem socket de arquivo

    attr = Ruleset(TUDO, 0, 0)
    fd = libc.syscall(444, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0))
    if fd < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset")
    try:
        for caminhos, acessos in ((_ESCREVE, RW), (_LE, RO)):
            for caminho in caminhos:
                try:
                    pfd = _os.open(caminho, _os.O_PATH | _os.O_CLOEXEC)
                except OSError:
                    continue
                try:
                    regra = Regra(acessos, pfd)
                    libc.syscall(445, ctypes.c_int(fd), ctypes.c_int(1), ctypes.byref(regra), ctypes.c_uint32(0))
                finally:
                    _os.close(pfd)
        if libc.syscall(446, ctypes.c_int(fd), ctypes.c_uint32(0)) != 0:
            raise OSError(ctypes.get_errno(), "landlock_restrict_self")
    finally:
        _os.close(fd)


def _seccomp():
    """Recusa exec, ptrace e troca de namespace no kernel (threads continuam liberadas)."""
    import ctypes

    sec = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    sec.seccomp_init.restype = ctypes.c_void_p
    sec.seccomp_init.argtypes = [ctypes.c_uint32]
    sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    sec.seccomp_load.argtypes = [ctypes.c_void_p]
    sec.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = sec.seccomp_init(ctypes.c_uint32(0x7FFF0000))  # SCMP_ACT_ALLOW
    if not ctx:
        raise OSError("seccomp_init")
    negar = 0x00050000 | _errno.EPERM  # SCMP_ACT_ERRNO(EPERM)
    # rede NAO entra aqui: o proxy do nexos mora em 127.0.0.1 e o seccomp nao distingue
    # destino (o argumento de connect e ponteiro). Quem orienta a rede e o gancho abaixo;
    # o cadeado duro desta versao e o disco (Landlock) e o processo (exec/namespace).
    syscalls = {
        "execve": 59,
        "execveat": 322,
        "ptrace": 101,
        "unshare": 272,
        "setns": 308,
        "mount": 165,
        "umount2": 166,
    }
    try:
        for nome, nr in syscalls.items():
            if sec.seccomp_rule_add(ctx, ctypes.c_uint32(negar), nr, 0) != 0:
                raise OSError("regra " + nome)
        if sec.seccomp_load(ctx) != 0:
            raise OSError("seccomp_load")
    finally:
        sec.seccomp_release(ctx)


try:
    _no_new_privs()
    _landlock()
except Exception as _e:  # kernel sem Landlock: segue com os ganchos do Python
    _avisar("disco sem restricao do kernel: " + str(_e))
try:
    _seccomp()
except Exception as _e:
    _avisar("rede sem restricao do kernel: " + str(_e))


import socket as _sock

_orig = _sock.socket

_PROXY = ("127.0.0.1", "::1", "localhost")
_EVENTOS_PROCESSO = (
    "subprocess.Popen",
    "os.system",
    "os.exec",
    "os.posix_spawn",
    "os.spawn",
    "os.fork",
    "os.forkpty",
    "pty.spawn",
)


class _RedeBloqueada(OSError):
    pass


def _recusar(*_a, **_k):
    raise _RedeBloqueada(
        "rede direta bloqueada no sandbox: use HTTP_PROXY/HTTPS_PROXY (o proxy do nexos) "
        "ou as ferramentas (nexos.web_search, nexos.web_open)"
    )


def _addr_de(args):
    """Aceita (socket, addr) ou (addr,) — o evento socket.connect varia por versao."""
    for a in args:
        if isinstance(a, (tuple, list)) and len(a) >= 2:
            return a[0], a[1]
    return None, None


def _auditar(evento, args):
    if evento == "socket.connect":
        host, port = _addr_de(args)
        try:
            if int(port) == _PORTA and str(host) in _PROXY:
                return
        except Exception:
            pass
        _recusar()
    if evento in _EVENTOS_PROCESSO:
        raise PermissionError(
            "execucao de processo bloqueada no sandbox: o script roda direto; "
            "para buscar dados use HTTP_PROXY/HTTPS_PROXY ou as ferramentas do nexos"
        )


def _liberado(addr):
    try:
        return int(addr[1]) == _PORTA and str(addr[0]) in _PROXY
    except Exception:
        return False


class _Socket(_orig):
    def connect(self, addr, *a, **k):
        if not _liberado(addr):
            _recusar()
        return super().connect(addr, *a, **k)

    def connect_ex(self, addr, *a, **k):
        if not _liberado(addr):
            _recusar()
        return super().connect_ex(addr, *a, **k)


_sock.socket = _Socket
_sys.addaudithook(_auditar)
`;
}

/** uid/gid estável por conta (20000..29999): o processo do script não é root. */
export function uidDoTenant(tenant: string): number {
  let h = 0;
  for (let i = 0; i < tenant.length; i++) h = (h * 31 + tenant.charCodeAt(i)) >>> 0;
  return 20000 + (h % 10000);
}

/** Só nome de pacote com versão/extras opcional — nada de URL, `-r`, `--index-url`, `git+`. */
const PACOTE_VALIDO =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(\s*\[[A-Za-z0-9_,.-]{1,80}\])?(\s*(==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9*+._-]{1,40})?$/;

/** Valida a lista declarada pelo modelo; recusa qualquer coisa que não seja nome/versão. */
export function pacotesValidos(lista: unknown): string[] {
  if (lista === undefined || lista === null) return [];
  const bruto = Array.isArray(lista) ? lista : [lista];
  const limpos: string[] = [];
  for (const item of bruto) {
    const nome = String(item ?? "").trim();
    if (!nome) continue;
    if (!PACOTE_VALIDO.test(nome)) {
      throw new Error(`dependencia invalida: "${nome}" (use nome ou nome==versao; sem URL, sem opcoes)`);
    }
    limpos.push(nome.replace(/\s+/g, ""));
  }
  return limpos;
}

async function existe(caminho: string): Promise<boolean> {
  try {
    await access(caminho, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pythonDoVenv(venv: string): string {
  return process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

function pipDoVenv(venv: string): string {
  return process.platform === "win32" ? path.join(venv, "Scripts", "pip.exe") : path.join(venv, "bin", "pip");
}

/** Tamanho da pasta do usuário em MB (0 quando ainda não existe). */
async function usoMb(pasta: string): Promise<number> {
  try {
    const { stdout } = await rodar("du", ["-sm", pasta], { timeout: 20000 });
    return Number(stdout.trim().split(/\s+/)[0] ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Garante o venv do usuário (cria na primeira execução). */
async function garantirVenv(base: string): Promise<string> {
  const venv = path.join(base, "venv");
  const py = pythonDoVenv(venv);
  if (await existe(py)) return venv;
  await mkdir(base, { recursive: true });
  log(`sandbox: criando venv do usuário em ${venv}`);
  await rodar(process.env.NEXOS_PYTHON_SISTEMA ?? "python3", ["-m", "venv", venv], {
    timeout: 120000,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: base },
  });
  if (!(await existe(py))) throw new Error("nao consegui criar o venv do usuario");
  return venv;
}

/** Instala no venv o que ainda falta da lista declarada. Devolve o que foi instalado agora. */
async function garantirDependencias(base: string, venv: string, pedidos: string[]): Promise<string[]> {
  if (!pedidos.length) return [];
  const lista = path.join(base, "dependencias.txt");
  const registro = (await existe(lista)) ? await readFile(lista, "utf8").catch(() => "") : "";
  const jaTem = new Set(
    registro
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[1] ?? "")
      .filter(Boolean)
      .map((p) => p.split(/[=<>!~]/)[0].toLowerCase()),
  );
  const faltam = pedidos.filter((p) => !jaTem.has(p.split(/[=<>!~ ]/)[0].toLowerCase()));
  if (!faltam.length) return [];

  const antes = await usoMb(base);
  if (antes >= TETO_MB) {
    throw new Error(`a pasta do usuario ja usa ${antes} MB (teto ${TETO_MB} MB); apague algo antes de instalar`);
  }

  log(`sandbox: instalando no venv de ${path.basename(base)}: ${faltam.join(", ")}`);
  try {
    await rodar(pipDoVenv(venv), ["install", "--no-input", "--no-warn-script-location", ...faltam], {
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: base,
        PIP_CACHE_DIR: path.join(base, "pip-cache"),
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });
  } catch (e) {
    const detalhe = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? e);
    throw new Error(`pip falhou: ${detalhe.slice(-1200)}`);
  }

  const quando = new Date().toISOString().slice(0, 10);
  await appendFile(lista, faltam.map((p) => `${quando} ${p}\n`).join(""), "utf8");

  const depois = await usoMb(base);
  if (depois > TETO_MB) {
    throw new Error(`instalacao passou do teto: ${depois} MB (limite ${TETO_MB} MB)`);
  }
  return faltam;
}

/**
 * v3.67 — `nexos.anexar(caminho)` dentro do script.
 *
 * O arquivo mora na pasta da conta (scripts/saida ou home) e precisa continuar lá: o caminho
 * é resolvido e conferido contra a raiz ANTES de qualquer leitura, e o realpath pega o caso do
 * symlink que aponta para fora. Sem isso um script poderia anexar /etc/shadow ao chat.
 */
async function anexarDoScript(caminhoBruto: string, base: string, user: Usuario): Promise<AnexoMeta> {
  const rel = String(caminhoBruto ?? "").trim();
  if (!rel) throw new Error("anexar: informe o caminho do arquivo (ex: scripts/saida/planilha.xlsx)");
  if (rel.includes("\0")) throw new Error("anexar: caminho invalido");
  const raiz = path.resolve(base) + path.sep;
  /* o script roda com cwd = scripts/saida, então "planilha.xlsx" e "scripts/saida/planilha.xlsx"
     precisam dar no mesmo arquivo — testa os dois e fica com o que existe. */
  const candidatos = [path.resolve(base, rel), path.resolve(base, "scripts", "saida", rel)];
  let real = "";
  for (const c of candidatos) {
    if (!c.startsWith(raiz)) continue;
    const achado = await realpath(c).catch(() => "");
    if (achado) { real = achado; break; }
  }
  if (!real) throw new Error("anexar: nao achei esse arquivo dentro da sua pasta (ex: scripts/saida/planilha.xlsx)");
  if (!real.startsWith(raiz)) throw new Error("anexar: caminho fora da sua pasta");
  const st = await stat(real).catch(() => null);
  if (!st?.isFile()) throw new Error("anexar: nao achei esse arquivo (ou nao e um arquivo)");
  if (st.size > TETO_ANEXO_PY)
    throw new Error(
      `anexar: arquivo de ${(st.size / 1048576).toFixed(1)} MB passa do teto de ${TETO_ANEXO_PY / 1048576} MB para anexo no chat — use enviar_para_maquina`,
    );
  const dados = await readFile(real);
  return criarAnexo(user, dados, { nome: path.basename(real), host: "servidor" });
}

/**
 * Roda um script Python na pasta do usuário, com as ferramentas do nexos como funções.
 * `user` é quem pediu: toda chamada de ferramenta passa por `chamarToolInterna` com ele.
 */
export async function rodarPython(
  codigo: string,
  user: Usuario,
  opts: { segundos?: number; dependencias?: unknown } = {},
): Promise<ResultadoPython> {
  const teto = Math.min(Math.max(opts.segundos ?? TETO_SEG, 5), 600);
  const inicio = Date.now();

  /* import dinâmico: mcp.ts importa este arquivo, e o ciclo só existe em runtime */
  const { chamarToolInterna, TOOLS } = await import("./mcp");
  const { motivoDeBloqueio } = await import("./mcp_acesso");

  const permitidas = TOOLS.filter(
    (t) => t.name !== "rodar_python" && motivoDeBloqueio(user.tenant, user.operador, t.name) === null,
  );
  const descricoes: Record<string, string> = {};
  for (const t of permitidas) descricoes[t.name] = t.description;

  const base = path.join(RAIZ, pastaDe(user.tenant));
  const pastaSaida = path.join(base, "scripts", "saida");
  const casa = path.join(base, "home");
  await mkdir(pastaSaida, { recursive: true });
  await mkdir(casa, { recursive: true });

  const venv = await garantirVenv(base);
  const instalados = await garantirDependencias(base, venv, pacotesValidos(opts.dependencias));

  /* T053 — o script não roda como root. A pasta da conta é só travessia (711); o que ele
     pode escrever (saida e home) pertence ao uid dele e é 700: o diretório de outra conta
     responde "permissão negada" mesmo que o script tente caminho absoluto. */
  const uid = uidDoTenant(user.tenant);
  const comoRoot = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
  if (comoRoot) {
    await chmod(path.dirname(base), 0o711).catch(() => {});
    await chmod(base, 0o711).catch(() => {});
    await chown(pastaSaida, uid, uid).catch(() => {});
    await chown(casa, uid, uid).catch(() => {});
  }
  await chmod(pastaSaida, 0o700).catch(() => {});
  await chmod(casa, 0o700).catch(() => {});

  const proxy = await subirProxy();
  const pasta = await mkdtemp(path.join(tmpdir(), "nexos-py-"));
  const script = path.join(pasta, "script.py");
  await writeFile(path.join(pasta, "nexos.py"), moduloPonte(permitidas.map((t) => t.name), descricoes), "utf8");
  /* v3.63 — Landlock: escrita só nas pastas da conta e no diretório do script;
     leitura no sistema (stdlib, venv, /etc, /proc). Quem cuida de rede e processo é o seccomp. */
  await writeFile(
    path.join(pasta, "sitecustomize.py"),
    moduloRede(
      proxy.porta,
      [pastaSaida, casa, pasta],
      [base, pasta, "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/proc", "/dev", "/tmp"],
    ),
    "utf8",
  );
  await writeFile(script, codigo, "utf8");
  await chmod(pasta, 0o755).catch(() => {});
  for (const nome of ["nexos.py", "sitecustomize.py", "script.py"]) {
    await chmod(path.join(pasta, nome), 0o644).catch(() => {});
  }

  const proxyUrl = `http://127.0.0.1:${proxy.porta}`;
  const filho = spawn("/bin/sh", ["-c", `ulimit -v ${TETO_MEM_MB * 1024}; exec ${JSON.stringify(pythonDoVenv(venv))} ${JSON.stringify(script)}`], {
    cwd: pastaSaida,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      PYTHONPATH: pasta,
      HOME: casa,
      TMPDIR: pasta,
      LANG: "C.UTF-8",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
    },
    ...(comoRoot ? { uid, gid: uid } : {}),
    /* [stdin, stdout, stderr, fd3] */
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  const chamadas: ChamadaFerramenta[] = [];
  /** v3.67: arquivos que o script entregou por `nexos.anexar` — vão para a bolha da conversa. */
  const anexosSaida: AnexoMeta[] = [];
  let texto = "";
  let erro = "";
  let truncado = false;

  const juntar = (destino: "saida" | "erro", pedaco: string) => {
    const total = texto.length + erro.length;
    if (total >= TETO_SAIDA) {
      truncado = true;
      return;
    }
    const sobra = TETO_SAIDA - total;
    const parte = pedaco.length > sobra ? pedaco.slice(0, sobra) : pedaco;
    if (parte.length < pedaco.length) truncado = true;
    if (destino === "saida") texto += parte;
    else erro += parte;
  };

  filho.stdout?.on("data", (d: Buffer) => juntar("saida", d.toString("utf8")));
  filho.stderr?.on("data", (d: Buffer) => juntar("erro", d.toString("utf8")));

  /* pedidos do script → ferramentas do servidor */
  const leitor = readline.createInterface({ input: filho.stdio[3] as NodeJS.ReadableStream });
  leitor.on("line", (linha) => {
    void (async () => {
      const t0 = Date.now();
      let nome = "?";
      try {
        const pedido = JSON.parse(linha) as { tool?: string; args?: Record<string, unknown> };
        nome = String(pedido.tool ?? "");
        if (!nome) throw new Error("pedido sem 'tool'");
        const args = (pedido.args ?? {}) as Record<string, unknown>;
        /* v3.67: `anexar` não é tool do MCP — é o caminho de volta do arquivo para a conversa. */
        const rotulo = nome === "__anexar" ? "anexar" : nome;
        const r =
          nome === "__anexar"
            ? await anexarDoScript(String(args.caminho ?? ""), base, user)
            : await chamarToolInterna(nome, args, user);
        if (nome === "__anexar") anexosSaida.push(r as AnexoMeta);
        chamadas.push({ ferramenta: rotulo, ok: true, ms: Date.now() - t0 });
        filho.stdin?.write(JSON.stringify({ ok: true, resultado: r }) + "\n");
      } catch (e) {
        chamadas.push({ ferramenta: nome === "__anexar" ? "anexar" : nome, ok: false, ms: Date.now() - t0 });
        filho.stdin?.write(JSON.stringify({ ok: false, erro: String((e as Error).message ?? e) }) + "\n");
      }
    })();
  });

  const codigoSaida = await new Promise<number | null>((resolve) => {
    const relogio = setTimeout(() => {
      log(`sandbox: script passou de ${teto}s, encerrando`);
      filho.kill("SIGKILL");
    }, teto * 1000);
    filho.on("exit", (c) => {
      clearTimeout(relogio);
      resolve(c);
    });
    filho.on("error", (e) => {
      clearTimeout(relogio);
      erro += `\n${String(e.message ?? e)}`;
      resolve(null);
    });
  });

  leitor.close();
  const destinos = [...proxy.destinos];
  await proxy.fechar().catch(() => {});
  await rm(pasta, { recursive: true, force: true }).catch(() => {});

  return {
    ok: codigoSaida === 0,
    codigo: codigoSaida,
    saida: texto.trimEnd(),
    erro: erro.trimEnd(),
    truncado,
    ms: Date.now() - inicio,
    chamadas,
    rede: destinos,
    instalados,
    pasta: `usuarios/${pastaDe(user.tenant)}/scripts/saida`,
    uso_mb: await usoMb(base),
    ...(anexosSaida.length ? { anexo: anexosSaida[0], anexos: anexosSaida } : {}),
  };
}

/* ---------------------------------------------- v3.74 (T057): despejo de saída */

/** Pasta da conta no disco — é o que `rodar_python` enxerga (cwd = scripts/saida). */
export function pastaDaConta(tenant: string): string {
  return path.join(RAIZ, pastaDe(tenant));
}

/** teto de UM arquivo de despejo: o que passar disso é gravado truncado, com aviso dentro
 *  do arquivo (o teto de disco da conta é outro guarda-chuva, TETO_MB). */
const TETO_DESPEJO_BYTES = 4 * 1024 * 1024;
/** quantos despejos a conta guarda; o mais velho sai na escrita do próximo. */
const MAX_DESPEJOS = 20;
/** quanto do começo e do fim vai para o payload (a soma fica abaixo de MAX_TEXTO_MODELO). */
const PREVIA_CHARS = 1400;

/** `despejos/ler_arquivo-20261106-121530-a1b2c3.txt` — nome determinístico o bastante para
 *  não colidir e legível o bastante para o dono achar na própria pasta. */
function nomeDoDespejo(nomeFerramenta: string, quando: Date): string {
  const base = String(nomeFerramenta || "ferramenta").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "ferramenta";
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const estampa =
    `${quando.getFullYear()}${p(quando.getMonth() + 1)}${p(quando.getDate())}` +
    `-${p(quando.getHours())}${p(quando.getMinutes())}${p(quando.getSeconds())}`;
  return `despejos/${base}-${estampa}-${randomBytes(3).toString("hex")}.txt`;
}

/** corte alinhado a linha, para a prévia não terminar no meio de um registro. */
function previa(texto: string, de: "comeco" | "fim"): string {
  if (texto.length <= PREVIA_CHARS) return texto;
  if (de === "comeco") {
    const fatia = texto.slice(0, PREVIA_CHARS);
    const corte = fatia.lastIndexOf("\n");
    return fatia.slice(0, corte > PREVIA_CHARS / 2 ? corte : PREVIA_CHARS);
  }
  const fatia = texto.slice(-PREVIA_CHARS);
  const corte = fatia.indexOf("\n");
  return fatia.slice(corte >= 0 && corte < PREVIA_CHARS / 2 ? corte + 1 : 0);
}

export type Despejo = {
  /** caminho relativo à pasta onde o script roda — é o que o modelo passa para `open()` */
  relativo: string;
  /** caminho absoluto dentro da conta (o dono/confere no disco) */
  caminho: string;
  bytes: number;
  /** o texto que entra no payload no lugar do despejo */
  referencia: string;
  /** ficha do arquivo na conversa (o dono baixa pelo card do chat) */
  anexo: AnexoMeta;
  /** true quando o texto integral coube no teto do arquivo */
  integro: boolean;
};

/**
 * v3.74 (T057) — a saída grande de ferramenta vira ARQUIVO na pasta da conta.
 *
 * Antes, `paraTexto` cortava em 4000 caracteres e a cauda não ficava em lugar nenhum:
 * o modelo trabalhava meio cego e o dono não tinha como recuperar o resto. Aqui o texto
 * INTEIRO é gravado em `<conta>/scripts/saida/despejos/…` (a mesma pasta que o
 * `rodar_python` usa como cwd, então o modelo relê o que precisa na rodada seguinte,
 * pagando contexto só quando pede) e vira também um anexo na conversa, para o dono baixar.
 *
 * O arquivo é do dono da conta: mesmo volume, mesma pasta que os scripts já escrevem,
 * dono = uid da conta, modo 0600. Não entra na base de conhecimento (não polui a busca
 * semântica das gavetas) e é apagado pela faxina da própria conta.
 */
export async function despejarSaida(
  texto: string,
  user: Usuario,
  nomeFerramenta: string,
  opts: { podeReler: boolean; quando?: Date } = { podeReler: true },
): Promise<Despejo> {
  const relativo = nomeDoDespejo(nomeFerramenta, opts.quando ?? new Date());
  const base = pastaDaConta(user.tenant);
  const absoluto = path.join(base, "scripts", "saida", relativo);
  if (!dentroDaConta(absoluto, base)) throw new Error("despejo: caminho fora da conta");
  const uid = uidDoTenant(user.tenant);
  const total = Buffer.byteLength(texto, "utf8");
  const estoura = total > TETO_DESPEJO_BYTES;
  const corpo = estoura
    ? `${texto.slice(0, TETO_DESPEJO_BYTES)}\n\n… [despejo aparado em ${TETO_DESPEJO_BYTES} bytes: o resultado tinha ${total} bytes]`
    : texto;

  await mkdir(path.dirname(absoluto), { recursive: true });
  await writeFile(absoluto, corpo, { encoding: "utf8", mode: 0o600 });
  /* o script roda como uid da conta (0700 na pasta): sem isto o arquivo nascido pelo
     servidor seria ilegível para a própria ferramenta de leitura do modelo */
  await chown(absoluto, uid, uid).catch(() => undefined);
  await chmod(absoluto, 0o600).catch(() => undefined);
  await podarDespejos(path.join(base, "scripts", "saida", "despejos"), MAX_DESPEJOS);

  const anexo = await criarAnexo(user, Buffer.from(corpo, "utf8"), {
    nome: path.basename(relativo),
    mime: "text/plain; charset=utf-8",
    host: "servidor",
  });

  const linhas = [
    `[saída aparada] ${nomeFerramenta} devolveu ${total} caracteres — o completo está gravado em \`${relativo}\` (${Buffer.byteLength(corpo, "utf8")} bytes, na sua pasta) e anexado nesta conversa para download.`,
    "",
    `COMEÇO (${previa(texto, "comeco").length} caracteres):`,
    previa(texto, "comeco"),
    "",
    `FIM (${previa(texto, "fim").length} caracteres):`,
    previa(texto, "fim"),
  ];
  linhas.push(
    "",
    opts.podeReler
      ? `O meio NÃO está aqui. Para ler o trecho que falta, chame \`rodar_python\` com \`open("${relativo}")\` (o cwd já é a sua pasta) e imprima só as linhas que precisa — ex.: \`[l for i,l in enumerate(open("${relativo}")) if 120 <= i < 180]\`.`
      : `O meio NÃO está aqui. Esta conta não tem \`rodar_python\` liberado, então o resto só está no arquivo anexado nesta conversa.`,
  );

  return { relativo, caminho: absoluto, bytes: Buffer.byteLength(corpo, "utf8"), referencia: linhas.join("\n"), anexo, integro: !estoura };
}

/** defesa de caminho (o nome da ferramenta vem de fora): nada de `..` escapando da conta */
function dentroDaConta(caminho: string, base: string): boolean {
  const b = path.resolve(base) + path.sep;
  return path.resolve(caminho).startsWith(b);
}

/** mantém só os `max` despejos mais recentes (log grande não come o disco da conta) */
async function podarDespejos(pasta: string, max: number): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const nomes = await readdir(pasta).catch(() => [] as string[]);
  if (nomes.length <= max) return;
  const comData = await Promise.all(
    nomes.map(async (n) => ({ n, m: await stat(path.join(pasta, n)).then((s) => s.mtimeMs).catch(() => 0) })),
  );
  comData.sort((a, b) => b.m - a.m);
  for (const velho of comData.slice(max)) await rm(path.join(pasta, velho.n), { force: true }).catch(() => undefined);
}
