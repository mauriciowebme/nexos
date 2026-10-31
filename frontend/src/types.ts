/* Tipos do contrato REST do nexos (v2). Um lugar só para todo o front. */

export type Gaveta = {
  tenant: string;
  memoria: string;
  chunks: number;
  docs: number;
  chunks_arquivados: number;
  primeiro_ingress: string | null;
  ultimo_ingress: string | null;
  /** v3.18: rotulo de exibicao (renomear T015 / auto T016); fixada no topo e arquivada fora (T019) */
  titulo?: string | null;
  fixada?: boolean;
  arquivada?: boolean;
};
export type GavetasResp = {
  operador: boolean;
  usuarios: string[];
  gavetas: Gaveta[];
  documentos_fonte: number;
};

export type DocItem = {
  doc_id: string;
  title: string;
  chunks: number;
  updated_at: string | null;
  chunks_arquivados: number;
  /** arquivo original guardado (pdf/docx/...); null quando o doc nasceu como texto */
  arquivo: {
    nome: string;
    tipo: string;
    ext?: string;
    editavel?: boolean;
    /** texto veio de OCR (imagem ou PDF escaneado) — confira no original */
    ocr?: boolean;
    tamanho: number;
  } | null;
};
export type DocsResp = { tenant: string; memoria: string; total: number; docs: DocItem[] };

export type Hit = {
  rank: number;
  score: number;
  chunk_id: number;
  doc_id: string;
  title: string;
  text: string;
  arquivado: boolean;
};
export type SearchResp = { tenant: string; memoria: string; items: Hit[]; total: number };

export type Job = {
  job_id: number;
  tenant: string;
  memoria: string;
  doc_id: string;
  title: string;
  status: string;
  chunks_total: number;
  chunks_feitos: number;
  erro: string | null;
  criado_em: string | null;
  finalizado_em: string | null;
};
export type JobsResp = { resumo_por_status: Record<string, number>; jobs: Job[] };

/** v3.48 (T050) — arquivo da pasta física do usuário (tabela anexos_maquina) */
export type AnexoFicha = {
  id: string;
  nome: string;
  mime: string;
  bytes: number;
  host: string;
  completo: boolean;
  criado_em: string;
};
export type AnexosResp = { total: number; anexos: AnexoFicha[] };

export type DocCompleto = {
  tenant: string;
  memoria: string;
  doc_id: string;
  title: string | null;
  content: string;
  size_bytes: number;
  origem: string;
  criado_em: string | null;
  atualizado_em: string | null;
};

export type JobStatus = {
  job_id: number;
  status: string;
  chunks_feitos: number;
  chunks_total: number;
  erro: string | null;
};
export type DecayResp = {
  arquivados_agora: number;
  docs_arquivados_agora: number;
  ativos: number;
  arquivados: number;
};
export type HealthResp = { status?: string; versao?: string; operador?: boolean; embedder?: string };

export type Escopo = { tenant: string; memoria: string };
/** telas de TOPO do menu lateral; "arquivos" e "editor" são passos do caminho */
export type Vista =
  | "painel"
  | "gavetas"
  | "chat"
  | "buscar"
  | "jobs"
  | "maquinas"
  | "mcp"
  | "config"
  | "arquivos"
  | "editor";

/* v3.6: máquinas por usuário (túnel absorvido) */
export type MaquinaLinha = {
  tenant: string;
  host: string;
  nome: string;
  so: string | null;
  usuario_win: string | null;
  ativo: boolean;
  visto_em: string | null;
  criado_em: string;
  online: boolean;
  desde: string | null;
};
export type ChaveClienteLinha = {
  id: string;
  tenant: string;
  nome: string;
  usada: boolean;
  host_ativado: string | null;
  ativacoes?: number;
  criado_em: string;
  expira_em: string;
};
export type MaquinasResp = { maquinas: MaquinaLinha[]; chaves?: ChaveClienteLinha[] };
export type PareamentoResp = { token: string; segundos: number; nome: string; tenant: string; expira_em: string };
export type MaquinasLogLinha = {
  tenant: string;
  host: string;
  cmd: string;
  exit: number;
  stdout: string;
  stderr: string;
  ms: number;
  origem: string;
  criado_em: string;
};

export type DashboardResp = {
  versao: string;
  escopo: string;
  numeros: {
    usuarios: number;
    operadores: number;
    gavetas: number;
    documentos: number;
    chunks: number;
    chunks_arquivados: number;
    buscas_hoje: number;
    chats_hoje: number;
  };
  fila: Record<string, number>;
  buscas_hoje: number;
  chats_hoje: number;
  por_usuario: { tenant: string; documentos: number; chunks: number; ultimo: string | null }[];
  ultimos: {
    tenant: string;
    memoria: string;
    doc_id: string;
    nome: string;
    tipo: string;
    ext: string;
    ocr: boolean;
    quando: string;
  }[];
  saude: { embedder: string; ocr: string; dim: number; provider: string };
};

export type UsuarioItem = {
  nome: string;
  papel: "usuario" | "operador";
  ativo: boolean;
  chave_hint: string;
  criado_em: string;
  origem_env: boolean;
  gavetas: number;
  documentos: number;
  ultimo: string | null;
  /** v3.5: preenchido quando a exclusão está agendada (a conta some depois da carência) */
  agendado_exclusao_em: string | null;
};
export type UsuariosResp = { usuarios: UsuarioItem[] };
export type NovoUsuarioResp = { nome: string; papel: string; chave: string; aviso: string };
/** v3.5: resposta do apagar-agendar */
export type RemoverUsuarioResp = {
  nome: string;
  removido: boolean;
  agendado: boolean;
  expira_em: string | null;
  carencia_dias: number;
  aviso: string;
};

export type ProviderResp = {
  configurado: boolean;
  escopo: string | null;
  origem: "propria" | "global" | null;
  tem_global: boolean;
  tipo: "litellm" | "openai" | "ollama";
  base_url: string;
  modelo: string;
  temperatura: number;
  system_prompt: string;
  tem_system_prompt: boolean;
  /** v3.34: texto padrão da casa para o botão "restaurar instruções padrão" */
  regras_padrao?: string;
  mcp_interno: boolean;
  max_rodadas: number;
  memoria_turnos: number;
  verbatim_turnos: number;
  /** v3.56 — compactação com a mecânica do mini-compress (é da conta) */
  comp?: {
    thresholdK: number;
    protectLastN: number;
    tailCharsCap: number;
    pairsBlockCap: number;
    summaryCharsCap: number;
    maxPairs: number;
  };
  reserva_tokens: number;
  /** v3.2: 0 = padrão do sistema; silencio_efetivo_s é o número que está valendo de fato */
  silencio_s: number;
  silencio_efetivo_s: number;
  contexto_tokens: number | null;
  contexto_detectado: number | null;
  janela_efetiva: number;
  origem_janela: "configurada" | "detectada" | "padrao";
  ativo: boolean;
  tem_chave: boolean;
  chave_mascarada: string;
  atualizado_em: string | null;
};

/** v3.15 — o rastro do turno como chega do servidor: pensamento com o tempo dele, fala de
 *  caminho, ferramenta com o tempo dela, na ordem em que aconteceu (o jeito do IA_GO).
 *  A tela tem a mesma forma em `lib/conversa` (com a marca de "ao vivo"). */
export type RastroServidor =
  | { tipo: "pensamento"; texto: string; ms: number }
  | { tipo: "narracao"; texto: string }
  | { tipo: "ferramenta"; servidor: string; nome: string; ok: boolean; ms: number };

/** v3.23 — tela gerada pelo agente: card com preview funcional (HTML+CSS+JS). */
export type Tela = { id: string; titulo: string; html: string };

/** O que o Chat chamou de ferramenta (registrado na tela e no histórico). */
export type ChamadaFerramenta = {
  servidor: string;
  nome: string;
  args: Record<string, unknown>;
  ok: boolean;
  resumo: string;
  ms: number;
};

export type ChatResp = {
  resposta: string;
  ferramentas: ChamadaFerramenta[];
  rodadas: number;
  modelo: string;
  provider: string;
  mcp_interno: boolean;
  ferramentas_ligadas: number;
  servidores: { interno: boolean; externos: number };
  tem_system_prompt: boolean;
  compactacao?: Compactacao | null;
  /** v3.23: telas geradas neste turno (cards com preview) */
  telas?: Tela[];
  ms: number;
  aviso: string | null;
};

/** O que a compactação determinística (v3.0) fez com o histórico antes de mandar ao modelo. */
export type Compactacao = {
  memoria_turnos: number;
  historico_lido: number;
  resumidas: number;
  aparadas: number;
  descartadas: number;
  tokens: number;
  disponivel: number;
  janela: number;
  origem_janela: "configurada" | "detectada" | "padrao";
  coube: boolean;
};
export type ChatHistorico = {
  tenant: string;
  memoria: string;
  mensagens: {
    id: number;
    papel: "user" | "assistant";
    texto: string;
    ferramentas: ChamadaFerramenta[];
    falas?: string[];
    /** v3.13: raciocínio do modelo (bloco "Pensou" ao reabrir a conversa) */
    raciocinio?: string;
    /** v3.15: a trilha do turno, na ordem real */
    rastro?: RastroServidor[];
    quando: string;
    /** v3.18 (T004/T018): de onde a resposta veio e quanto custou */
    fontes?: string[];
    custo?: { tok_in?: number; tok_out?: number; ms?: number } | null;
    /** v3.19: quem respondeu (nome do provedor; ausente = padrão da casa) */
    provedor?: string;
    modelo?: string;
    /** v3.23: telas geradas (o card volta ao reabrir a conversa) */
    telas?: Tela[];
  }[];
};

/** v3.19: provedor nomeado cadastrado em Configurações (chave nunca volta inteira) */
export type Provedor = {
  id: number;
  nome: string;
  tipo: string;
  base_url: string;
  modelo: string;
  chave_mascarada: string;
  ativo: boolean;
  padrao: boolean;
  escopo: string;
  modelos: string[];
  modelos_em: string | null;
};

export type ProvedoresResp = { provedores: Provedor[] };

export type ServidorMcp = {
  nome: string;
  url: string;
  ativo: boolean;
  tem_cabecalho: boolean;
  cabecalho_mascarado: string;
  ferramentas: number;
  nomes: string[];
  erro: string | null;
  atualizado_em: string;
};
export type ServidoresResp = { servidores: ServidorMcp[]; controle_maquinas?: boolean; usuarios_habilitado?: boolean };

/** v3.36 — a tela MCP: o que ESTA conta alcança hoje. */
export type McpFerramenta = {
  nome: string;
  descricao: string;
  grupo: string;
  permitida: boolean;
  ajustavel: boolean;
  motivo: "papel" | "maquinas" | "desligada" | "servidor_desligado" | null;
};
export type McpCatalogoResp = {
  caminho: string;
  habilitado: boolean;
  papel: "operador" | "usuario";
  controle_maquinas: boolean;
  ferramentas: McpFerramenta[];
};
export type TesteMcpResp = {
  nome: string;
  url: string;
  ferramentas: number;
  nomes: string[];
  servidor: string | null;
  ms: number;
};

export type ConfigResp = {
  versao: string;
  limites: Record<string, number>;
  esquecimento: {
    ativo: boolean;
    dias_arquivar: number;
    dias_excluir_arquivado: number;
    dias_carencia: number;
    origem: Record<string, string>;
    min_acessos: number;
    intervalo_minutos: number;
  };
  modelo_embedding: string;
};