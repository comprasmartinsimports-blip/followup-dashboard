// Custo dos Envios no Mercado Livre — tabela oficial e as contas em volta dela.
//
// Fonte: https://www.mercadolivre.com.br/ajuda/40538 — "Custos dos Envios no
// Mercado Livre para MercadoLíder, reputação verde ou sem reputação". Vale para
// produtos NOVOS enviados por Envios Full, Coleta e Agências.
//
// Fica num arquivo separado porque é DADO, não lógica: quando o Mercado Livre
// reajustar, é este arquivo que muda (ou a tabela editada em Configurações, que
// tem prioridade sobre esta). A data abaixo é o que a tela mostra para ninguém
// precificar em cima de uma tabela velha sem perceber.

export const FRETE_ML_TABELA_VERSAO = "Tabela de 11/09/2026 — MercadoLíder, reputação verde ou sem reputação";
export const FRETE_ML_TABELA_FONTE = "https://www.mercadolivre.com.br/ajuda/40538";

// Faixas de peso, pelo limite SUPERIOR em kg. "Até 0,3 kg" inclui 0,3;
// "De 0,3 a 0,5 kg" é o que passa de 0,3 e vai até 0,5 — e assim por diante.
export const FRETE_ML_FAIXAS_PESO = [
  0.3, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 20,
  25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, Infinity,
];

// Faixas de preço do anúncio, pelo limite superior. A última é "a partir de R$ 200".
export const FRETE_ML_FAIXAS_PRECO = [18.99, 48.99, 78.99, 99.99, 119.99, 149.99, 199.99, Infinity];

export const FRETE_ML_ROTULOS_PRECO = [
  "R$ 0 a R$ 18,99", "R$ 19 a R$ 48,99", "R$ 49 a R$ 78,99", "R$ 79 a R$ 99,99",
  "R$ 100 a R$ 119,99", "R$ 120 a R$ 149,99", "R$ 150 a R$ 199,99", "A partir de R$ 200",
];

// Uma linha por faixa de peso, uma coluna por faixa de preço — na mesma ordem
// das duas listas acima.
export const FRETE_ML_VALORES = [
  [ 5.65,  6.85,  8.15,  12.95,  14.95,  16.95,  19.05,  21.65], // até 0,3 kg
  [ 5.95,  6.95,  8.25,  13.85,  16.15,  18.15,  20.45,  23.25], // 0,3 a 0,5
  [ 6.05,  7.15,  8.45,  14.45,  16.85,  19.05,  21.35,  24.45], // 0,5 a 1
  [ 6.15,  7.35,  8.65,  14.75,  17.15,  19.45,  21.75,  25.45], // 1 a 1,5
  [ 6.25,  7.45,  8.75,  15.05,  17.65,  19.85,  22.25,  25.55], // 1,5 a 2
  [ 6.35,  8.65,  9.15,  16.45,  19.15,  21.65,  24.35,  27.05], // 2 a 3
  [ 6.45,  8.75,  9.75,  17.85,  20.75,  23.35,  26.35,  29.25], // 3 a 4
  [ 6.55,  8.85, 10.25,  19.75,  22.85,  26.05,  29.25,  32.45], // 4 a 5
  [ 6.65,  8.95, 10.35,  25.95,  29.15,  33.35,  36.45,  40.85], // 5 a 6
  [ 6.75,  9.05, 10.45,  27.55,  31.65,  36.75,  40.85,  45.25], // 6 a 7
  [ 6.85,  9.25, 10.55,  29.45,  34.35,  39.25,  44.15,  49.35], // 7 a 8
  [ 6.95,  9.35, 10.65,  30.25,  35.25,  40.35,  45.35,  50.75], // 8 a 9
  [ 7.05,  9.45, 10.85,  38.25,  45.05,  51.95,  58.75,  65.85], // 9 a 10
  [ 7.05,  9.65, 11.05,  41.65,  48.55,  55.45,  62.35,  69.35], // 10 a 11
  [ 7.15, 10.05, 11.45,  42.55,  49.75,  56.85,  63.85,  70.95], // 11 a 13
  [ 7.25, 10.25, 11.65,  45.55,  52.95,  60.55,  68.15,  75.65], // 13 a 15
  [ 7.35, 10.45, 11.85,  48.95,  56.55,  64.05,  71.35,  79.35], // 15 a 17
  [ 7.45, 10.65, 12.05,  55.15,  64.35,  73.55,  82.75,  91.95], // 17 a 20
  [ 7.65, 11.05, 12.25,  64.55,  75.75,  85.45,  96.25, 106.85], // 20 a 25
  [ 7.75, 11.25, 12.45,  66.45,  76.05,  86.25,  97.15, 107.85], // 25 a 30
  [ 7.85, 11.45, 12.65,  68.35,  79.65,  89.75, 100.05, 107.95], // 30 a 40
  [ 7.95, 11.65, 12.85,  70.95,  81.85,  92.85, 103.45, 111.65], // 40 a 50
  [ 8.05, 11.85, 13.05,  75.55,  87.25,  99.05, 110.25, 119.05], // 50 a 60
  [ 8.15, 12.05, 13.25,  80.95,  93.75, 105.95, 118.05, 127.45], // 60 a 70
  [ 8.25, 12.25, 13.45,  84.65,  97.95, 110.75, 123.35, 133.15], // 70 a 80
  [ 8.35, 12.45, 13.65,  94.05, 108.35, 122.95, 136.95, 147.85], // 80 a 90
  [ 8.45, 12.65, 13.85, 107.45, 124.85, 140.45, 156.45, 168.85], // 90 a 100
  [ 8.55, 12.85, 14.05, 120.15, 138.95, 156.95, 174.85, 188.85], // 100 a 125
  [ 8.65, 12.85, 14.25, 127.45, 147.05, 166.55, 185.55, 200.35], // 125 a 150
  [ 8.75, 12.85, 14.45, 167.05, 193.35, 218.45, 243.45, 262.85], // mais de 150
];

// Rótulo legível de cada faixa de peso, montado a partir dos limites — assim a
// lista de valores e os rótulos nunca saem de sincronia.
export function rotuloFaixaPeso(i) {
  var ate = FRETE_ML_FAIXAS_PESO[i];
  if (i === 0) return "Até " + fmtKg(ate) + " kg";
  if (ate === Infinity) return "Mais de " + fmtKg(FRETE_ML_FAIXAS_PESO[i - 1]) + " kg";
  return "De " + fmtKg(FRETE_ML_FAIXAS_PESO[i - 1]) + " a " + fmtKg(ate) + " kg";
}
function fmtKg(v) { return String(v).replace(".", ","); }

export function indiceFaixaPeso(peso) {
  if (!(peso > 0)) return -1;
  for (var i = 0; i < FRETE_ML_FAIXAS_PESO.length; i++) {
    if (peso <= FRETE_ML_FAIXAS_PESO[i]) return i;
  }
  return FRETE_ML_FAIXAS_PESO.length - 1;
}

export function indiceFaixaPreco(preco) {
  if (!(preco > 0)) return -1;
  for (var i = 0; i < FRETE_ML_FAIXAS_PRECO.length; i++) {
    if (preco <= FRETE_ML_FAIXAS_PRECO[i]) return i;
  }
  return FRETE_ML_FAIXAS_PRECO.length - 1;
}

// O custo de envio para um peso e um preço. Devolve null quando falta um dos
// dois — um frete chutado por medida faltando entra na conta da margem com cara
// de número apurado, e é pior do que uma célula vazia pedindo o dado.
//
// `valores` permite passar a tabela editada em Configurações; sem ela, usa a oficial.
export function freteML(peso, preco, valores) {
  var ip = indiceFaixaPeso(peso), iv = indiceFaixaPreco(preco);
  if (ip < 0 || iv < 0) return null;
  var tab = valores && valores.length === FRETE_ML_VALORES.length ? valores : FRETE_ML_VALORES;
  var linha = tab[ip];
  if (!linha || linha[iv] == null || !(parseFloat(linha[iv]) >= 0)) return null;
  var valor = parseFloat(linha[iv]);
  var observacao = "";
  // Regra do rodapé da tabela: produto de menos de R$ 19 paga no máximo METADE
  // do preço do produto. Sem isto, um item de R$ 8 apareceria pagando R$ 5,65 de
  // frete quando o teto real é R$ 4,00.
  if (preco < 19 && valor > preco / 2) {
    valor = preco / 2;
    observacao = "limitado a metade do preço (regra dos produtos abaixo de R$ 19)";
  }
  return {
    valor: valor,
    indicePeso: ip,
    indicePreco: iv,
    faixaPeso: rotuloFaixaPeso(ip),
    faixaPreco: FRETE_ML_ROTULOS_PRECO[iv],
    observacao: observacao,
  };
}
