#!/bin/bash
# Copia diaria consistente de la base de datos (se conservan 7 días).
mkdir -p /root/backups-db
F=/root/backups-db/data-$(date +%F).db
rm -f "$F"
cd /root/whatsapp-broadcast && node --no-warnings -e '
  const {DatabaseSync}=require("node:sqlite");
  const d=new DatabaseSync("data.db");
  d.exec("VACUUM INTO \x27'"$F"'\x27");' && echo "ok $F" || echo "FALLO backup"
find /root/backups-db -name 'data-*.db' -mtime +7 -delete
