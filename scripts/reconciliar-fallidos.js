// Devuelve lo cobrado por envíos que Meta aceptó y luego reportó como fallidos.
// Uso: node scripts/reconciliar-fallidos.js [--dry-run]
// Idempotente (usa envios.reembolsado). Respalda data.db antes de correrlo.
import { db } from '../db.js';
import { reembolsarEnvio } from '../campanas.js';
import { costoPorMensaje } from '../creditos.js';
import { pesoMensaje } from '../planes.js';

const dryRun = process.argv.includes('--dry-run');

const filas = db.prepare(`
  SELECT e.id, c.cliente_id, c.canal_cobro, c.categoria_plantilla, c.encabezado_tipo
  FROM envios e JOIN campanas c ON c.id = e.campana_id
  WHERE e.estado = 'fallido' AND e.wa_message_id IS NOT NULL AND e.reembolsado = 0
    AND c.canal_cobro IS NOT NULL AND c.categoria_plantilla IS NOT NULL
`).all();

const porCliente = new Map();
let hechos = 0;
for (const f of filas) {
  const monto = f.canal_cobro === 'plan' ? pesoMensaje(f.categoria_plantilla) : costoPorMensaje(f.categoria_plantilla, f.encabezado_tipo);
  const acc = porCliente.get(f.cliente_id) || { canal: f.canal_cobro, envios: 0, monto: 0 };
  acc.envios += 1;
  acc.monto += monto;
  porCliente.set(f.cliente_id, acc);
  if (!dryRun && reembolsarEnvio(f.id)) hechos += 1;
}

for (const [clienteId, a] of porCliente) {
  console.log(`cliente ${clienteId} (${a.canal}): ${a.envios} envíos fallidos, ${a.monto} ${a.canal === 'plan' ? 'medios' : 'COP'}`);
}
console.log(dryRun ? `Dry-run: ${filas.length} envíos por reembolsar.` : `Reembolsados: ${hechos} de ${filas.length}.`);
