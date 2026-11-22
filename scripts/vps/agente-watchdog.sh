#!/bin/bash
# Vigila whatsapp-broadcast cada minuto: si no responde lo reinicia y avisa por Telegram.
ESTADO=/var/run/agente-watchdog.caido
URL=http://localhost:4100/login.html
avisar() {
  local texto="$1"
  local creds
  creds=$(cd /root/whatsapp-broadcast && node --no-warnings -e '
    const {DatabaseSync}=require("node:sqlite");
    const d=new DatabaseSync("data.db",{readOnly:true});
    const r=d.prepare("select telegram_token t, telegram_chat_id c from agente_config where cliente_id=1").get();
    console.log((r.t||"")+" "+(r.c||""));' 2>/dev/null)
  local tok="${creds%% *}" chat="${creds##* }"
  [ -n "$tok" ] && [ -n "$chat" ] && curl -s -m 15 -o /dev/null "https://api.telegram.org/bot${tok}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=${texto}"
}
sano() { curl -sf -m 10 -o /dev/null "$URL"; }

if sano; then
  if [ -f "$ESTADO" ]; then rm -f "$ESTADO"; avisar "✅ El servidor del agente ya responde otra vez."; fi
else
  sleep 8
  if sano; then exit 0; fi   # falla momentánea
  pm2 restart whatsapp-broadcast >/dev/null 2>&1
  sleep 20
  if sano; then
    avisar "⚠️ El servidor del agente dejó de responder y lo reinicié automáticamente. Ya funciona."
  elif [ ! -f "$ESTADO" ]; then
    touch "$ESTADO"
    avisar "🔴 El servidor del agente sigue caído después de reiniciarlo. Hay que revisar el VPS (ssh root@2.25.80.190)."
  fi
fi
# Disco casi lleno: aviso una vez al día
USO=$(df / --output=pcent | tail -1 | tr -dc '0-9')
if [ "${USO:-0}" -ge 90 ] && [ ! -f "/var/run/agente-disco-$(date +%F)" ]; then
  touch "/var/run/agente-disco-$(date +%F)"; avisar "⚠️ Disco del VPS al ${USO}%."
fi
