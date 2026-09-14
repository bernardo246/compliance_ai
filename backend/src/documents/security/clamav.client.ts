import { connect } from 'net';

/**
 * Cliente mínimo do protocolo `INSTREAM` do `clamd` (daemon do ClamAV),
 * implementado direto sobre `net` (TCP) — sem depender de nenhuma lib de
 * terceiros. Protocolo (documentado em `man clamd`):
 *
 *   1. Cliente conecta e manda `zINSTREAM\0`.
 *   2. Cliente manda o arquivo em pedaços: cada pedaço é um inteiro de 4
 *      bytes big-endian com o tamanho, seguido dos bytes do pedaço.
 *   3. Um pedaço de tamanho zero sinaliza o fim do arquivo.
 *   4. `clamd` responde uma linha: "stream: OK" (limpo) ou
 *      "stream: <assinatura> FOUND" (infectado), terminada em NUL.
 *
 * Não vem com nenhum `clamd` — é preciso ter um rodando e acessível em
 * `CLAMAV_HOST:CLAMAV_PORT` (ex.: `docker run -p 3310:3310 clamav/clamav`)
 * para `ANTIVIRUS_ENABLED=true` funcionar. Ver README.
 */

const CHUNK_SIZE = 64 * 1024;

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface ClamAvScanResult {
  clean: boolean;
  /** Nome da assinatura detectada, quando `clean` é `false`. */
  signature?: string;
  raw: string;
}

export function scanWithClamAv(buffer: Buffer, options: ClamAvOptions): Promise<ClamAvScanResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host, port: options.port });
    let response = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(`Timeout (${options.timeoutMs}ms) ao falar com o ClamAV em ${options.host}:${options.port}.`),
        ),
      );
    }, options.timeoutMs);

    socket.on('error', (err) => {
      settle(() =>
        reject(new Error(`Falha ao conectar ao ClamAV em ${options.host}:${options.port}: ${err.message}`)),
      );
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');

      for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
        const sizeHeader = Buffer.alloc(4);
        sizeHeader.writeUInt32BE(chunk.length, 0);
        socket.write(sizeHeader);
        socket.write(chunk);
      }
      // Pedaço de tamanho zero = fim do stream.
      socket.write(Buffer.alloc(4));
    });

    socket.on('data', (data) => {
      response += data.toString('utf-8');
    });

    socket.on('close', () => {
      settle(() => {
        const cleaned = response.replace(/\0/g, '').trim();

        if (/\bOK$/.test(cleaned)) {
          resolve({ clean: true, raw: cleaned });
          return;
        }

        const infectado = /stream:\s*(.+?)\s+FOUND$/.exec(cleaned);
        if (infectado) {
          resolve({ clean: false, signature: infectado[1], raw: cleaned });
          return;
        }

        reject(new Error(`Resposta inesperada do ClamAV: "${cleaned || '(vazia)'}"`));
      });
    });
  });
}
