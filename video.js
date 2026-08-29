import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Binario de ffmpeg. Se puede apuntar a una ruta explícita con FFMPEG_PATH
// (útil en VPS donde no está en el PATH del proceso de Node).
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Límite de Meta para el video del encabezado de una plantilla.
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;

let ffmpegDisponibleCache;

/**
 * Chequea una sola vez si el binario de ffmpeg responde. El resultado
 * se cachea para no pagar un spawn por cada campaña.
 */
export async function ffmpegDisponible() {
  if (ffmpegDisponibleCache !== undefined) return ffmpegDisponibleCache;
  ffmpegDisponibleCache = await new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
  return ffmpegDisponibleCache;
}

/**
 * Re-codifica un video para que WhatsApp lo muestre bien en TODOS los
 * clientes. Android es el más estricto: rechaza como "archivo dañado"
 * los videos que iOS y WhatsApp Web sí reproducen (típicamente los del
 * iPhone, que graba en HEVC/H.265).
 *
 * La salida cumple lo que pide Meta para el header de plantillas:
 *   - contenedor MP4
 *   - video H.264 perfil baseline, pixel format yuv420p, dimensiones pares
 *   - audio AAC
 *   - `moov atom` al principio (faststart) para streaming progresivo
 *
 * Si ffmpeg no está instalado o la conversión falla, devuelve el buffer
 * original sin tocar (`convertido: false`) — mejor mandar el video como
 * viene que abortar la campaña.
 *
 * @param {Buffer} buffer - video original subido por el usuario
 * @returns {Promise<{buffer: Buffer, mimetype: string, convertido: boolean, error?: string}>}
 */
export async function normalizarVideoWhatsApp(buffer) {
  if (!(await ffmpegDisponible())) {
    return { buffer, mimetype: 'video/mp4', convertido: false, error: 'ffmpeg no disponible' };
  }

  const base = path.join(tmpdir(), `wa-video-${randomUUID()}`);
  const entrada = `${base}-in`;
  const salida = `${base}-out.mp4`;

  try {
    await fs.writeFile(entrada, buffer);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', entrada,
        '-c:v', 'libx264',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-pix_fmt', 'yuv420p',
        // Fuerza dimensiones pares (yuv420p las exige) sin deformar.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-preset', 'veryfast',
        '-crf', '28',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-max_muxing_queue_size', '1024',
        '-f', 'mp4',
        salida,
      ];
      const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('la conversión del video tardó demasiado (>180s)'));
      }, 180_000);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg terminó con código ${code}: ${stderr.slice(-400)}`));
      });
    });

    const convertido = await fs.readFile(salida);
    return { buffer: convertido, mimetype: 'video/mp4', convertido: true };
  } catch (err) {
    return { buffer, mimetype: 'video/mp4', convertido: false, error: err.message };
  } finally {
    await fs.rm(entrada, { force: true }).catch(() => {});
    await fs.rm(salida, { force: true }).catch(() => {});
  }
}
