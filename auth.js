import crypto from 'crypto';

const KEYLEN = 64;

/**
 * Hashea una contraseña con scrypt (nativo de Node, sin dependencias).
 * Devuelve hash y salt en hex para guardar en la tabla `clientes`.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const intento = crypto.scryptSync(password, salt, KEYLEN);
  const guardado = Buffer.from(hash, 'hex');
  if (intento.length !== guardado.length) return false;
  return crypto.timingSafeEqual(intento, guardado);
}
